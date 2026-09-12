/**
 * Spawns a terminal emulator on this machine to run a harness resume command
 * in a workflow's workdir — the server-side half of the UI's "Open
 * conversation" button. Only makes sense because the hub is a local
 * single-user tool (see hub/ui/index.html's "Local single-user tool" note):
 * the browser can't open an OS terminal window itself, so the server does it
 * on the operator's own machine.
 *
 * "That machine" is not always Linux: the hub installs and runs fine on macOS
 * and Windows, so the launch is planned per `process.platform` rather than
 * against one hardcoded list of X11 emulators.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shellQuote } from "./awb.ts";

// Indirection so tests can swap in fakes without touching real terminal
// emulators (there usually aren't any on a CI box, and we don't want to pop
// windows during `node --test` anyway) — and without writing temp files or
// being at the mercy of whichever platform the tests happen to run on.
export const _impl = {
	spawn: nodeSpawn,
	platform: (): NodeJS.Platform => process.platform,
	writeScript: writeTempScript,
};

export class NoTerminalEmulatorError extends Error {}

interface TerminalCandidate {
	bin: string;
	/** Argv for this candidate — passed as argv, not through a shell. */
	args: string[];
	/** Name for the "tried …" error; defaults to `bin` where that's the whole story. */
	label?: string;
	/**
	 * Wait for exit 0 instead of counting a successful spawn as success. Needed
	 * wherever the binary is a launcher that's always present (macOS `open`),
	 * so "spawned fine" says nothing about whether the app it was asked for
	 * exists — only its exit status does.
	 */
	awaitExit?: boolean;
}

/**
 * PowerShell single-quoting, escaping an embedded `'` by doubling it — the
 * PowerShell counterpart of awb's POSIX `shellQuote`, for the one value we
 * interpolate ourselves on Windows (the workdir).
 */
function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** `KEY='value' ` prefixes for a POSIX command line (the Linux/macOS plans). */
function posixEnvPrefix(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([k, v]) => `${k}=${shellQuote(v)} `)
		.join("");
}

/** `$env:KEY = 'value'` lines for the Windows PowerShell script. */
function psEnvLines(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}\r\n`)
		.join("");
}

/**
 * Writes `contents` to a private temp file and returns its path. Used by the
 * macOS and Windows plans, which both hand a *file* to the terminal rather
 * than a command string: `open -a Terminal` takes a document, not a command,
 * and routing through AppleScript's `do script` instead would mean escaping an
 * already-shell-quoted command a second time, in a second syntax. A file has
 * no such layer — the bytes are the script.
 */
async function writeTempScript(contents: string, ext: string): Promise<string> {
	const file = path.join(os.tmpdir(), `agentmesh-resume-${randomUUID()}${ext}`);
	await writeFile(file, contents, { mode: 0o700 });
	// writeFile's mode is masked by the umask; chmod isn't. The file holds a
	// command line, and it has to be executable for Terminal.app to run it.
	await chmod(file, 0o700);
	return file;
}

// Linux/X11 preference order: try each in turn until one is actually present.
// `-e`/`--` here all take the *rest* of argv as a program+args to exec, not one
// string — that's why "bash", "-c", shellCmd are three separate elements.
const LINUX_CANDIDATES: { bin: string; args: (shellCmd: string) => string[] }[] = [
	{ bin: "x-terminal-emulator", args: (cmd) => ["-e", "bash", "-c", cmd] },
	{ bin: "gnome-terminal", args: (cmd) => ["--", "bash", "-c", cmd] },
	{ bin: "konsole", args: (cmd) => ["-e", "bash", "-c", cmd] },
	{ bin: "xterm", args: (cmd) => ["-e", "bash", "-c", cmd] },
];

/**
 * The candidates to try on Linux (and any other Unix that isn't macOS).
 * `; exec bash` keeps the window open once the harness exits instead of
 * dropping the user back to a dead terminal.
 */
function linuxPlan(workdir: string, resumeCommand: string, env: Record<string, string>): TerminalCandidate[] {
	const shellCmd = `cd ${shellQuote(workdir)} && ${posixEnvPrefix(env)}${resumeCommand}; exec bash`;
	return LINUX_CANDIDATES.map((c) => ({ bin: c.bin, args: c.args(shellCmd) }));
}

/**
 * macOS: write the command to an executable `.command` file and hand it to a
 * terminal via `open -a`.
 *
 * Only Terminal.app and iTerm are offered, in that order. Terminal.app ships
 * with every macOS and definitely *runs* a `.command` document; a third-party
 * terminal handed the same document may just open a window and ignore it —
 * which `open` would report as success, leaving the user with an empty window
 * and no error. A guaranteed-correct default beats guessing a favourite.
 *
 * `exec "$SHELL"` rather than Linux's `exec bash`: macOS's /bin/bash is 3.2 and
 * has not been the default shell since Catalina, so the window would otherwise
 * hand the user a shell that isn't theirs.
 */
async function darwinPlan(workdir: string, resumeCommand: string, env: Record<string, string>): Promise<TerminalCandidate[]> {
	const script = `#!/bin/bash\ncd ${shellQuote(workdir)} && ${posixEnvPrefix(env)}${resumeCommand}\nexec "\${SHELL:-/bin/bash}"\n`;
	const file = await _impl.writeScript(script, ".command");
	return [
		{ bin: "open", args: ["-a", "Terminal", file], label: "Terminal.app", awaitExit: true },
		{ bin: "open", args: ["-a", "iTerm", file], label: "iTerm.app", awaitExit: true },
	];
}

/**
 * Windows: PowerShell, not cmd.exe. The resume command is built with POSIX
 * single quotes (`claude --resume 'sess-1'`, and every `-v`/`-w` of a docker
 * resume), which cmd.exe passes through *including* the quotes — it would
 * resume a session whose id literally contains apostrophes. PowerShell reads
 * single quotes as a literal string, so the command survives unchanged.
 *
 * Caveat this can't fix: a value containing an embedded `'` is escaped by
 * `shellQuote` as `'\''`, which is POSIX-only. We can't re-quote an opaque
 * command string, so only the workdir (ours to quote) is `psQuote`d.
 *
 * `-NoExit` is the keep-the-window-open half, and `-ExecutionPolicy Bypass` is
 * required because the default policy on a client Windows refuses to run a
 * `.ps1` from disk at all.
 */
async function windowsPlan(workdir: string, resumeCommand: string, env: Record<string, string>): Promise<TerminalCandidate[]> {
	const script = `Set-Location -LiteralPath ${psQuote(workdir)}\r\n${psEnvLines(env)}${resumeCommand}\r\n`;
	const file = await _impl.writeScript(script, ".ps1");
	const pwsh = ["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", file];
	return [
		// Windows Terminal: a GUI app, so it draws its own window when spawned
		// detached. Preferred where present (default on Windows 11).
		{ bin: "wt.exe", args: ["-d", workdir, ...pwsh] },
		// Fallback: `start` is what allocates a *new console window*. Spawning
		// powershell.exe directly would not — node's `detached` maps to
		// DETACHED_PROCESS on Windows, i.e. no console at all, so the resume
		// would run invisibly.
		{ bin: "cmd.exe", args: ["/c", "start", "", ...pwsh], label: "cmd.exe start" },
	];
}

/** Tries to launch one candidate; resolves false (never rejects) on ENOENT/spawn failure. */
function trySpawn(candidate: TerminalCandidate): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		let child: ChildProcess;
		try {
			child = _impl.spawn(candidate.bin, candidate.args, { detached: true, stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		child.once("error", () => settle(false));
		if (candidate.awaitExit) {
			// Short-lived launcher: its exit status is the only evidence of whether
			// the app it was asked for actually exists.
			child.once("exit", (code) => settle(code === 0));
			return;
		}
		child.once("spawn", () => {
			// detached + unref: the terminal is a real desktop window the user
			// keeps around after this request returns, so it must survive the
			// hub process exiting, not get killed with it.
			child.unref();
			settle(true);
		});
	});
}

/** The candidates for this machine's OS, in the order they should be tried. */
async function planFor(platform: NodeJS.Platform, workdir: string, resumeCommand: string, env: Record<string, string>): Promise<TerminalCandidate[]> {
	if (platform === "darwin") return darwinPlan(workdir, resumeCommand, env);
	if (platform === "win32") return windowsPlan(workdir, resumeCommand, env);
	return linuxPlan(workdir, resumeCommand, env);
}

/**
 * Opens a terminal in `workdir` running `resumeCommand`, trying each terminal
 * known for this platform until one launches. `env` holds extra variables the
 * resumed harness needs (awb's `harnessResumeEnv`), set in the shell/script
 * the command runs in.
 * Throws NoTerminalEmulatorError if none of the candidates are available.
 */
export async function openResumeTerminal(workdir: string, resumeCommand: string, env: Record<string, string> = {}): Promise<void> {
	const candidates = await planFor(_impl.platform(), workdir, resumeCommand, env);
	for (const candidate of candidates) {
		if (await trySpawn(candidate)) return;
	}
	throw new NoTerminalEmulatorError(
		`no terminal emulator found (tried ${candidates.map((c) => c.label ?? c.bin).join(", ")})`,
	);
}
