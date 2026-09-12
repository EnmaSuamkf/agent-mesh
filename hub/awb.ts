/**
 * Bridge to the local agent-webhook-bridge install: the hub creates hooks by
 * writing awb's hooks.json directly — the broker re-reads that file on every
 * request, so a hook registered here is live immediately, no restart. Same
 * file format `awb add` writes (agent-webhook-bridge/broker/config.ts); the
 * hub only ever adds "trigger" hooks with the fields the mesh needs.
 *
 * This only works while hub and broker share a machine (phase 1). Remote
 * nodes in phase 2 will register their own hooks and use the "existing hook"
 * path instead.
 */
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface AwbConfig {
	host: string;
	port: number;
	maxBodyBytes: number;
	publicBaseUrl: string | null;
	hooks: Record<string, Record<string, unknown>>;
}

// Mirrors awb's own defaults so a machine where the broker has never saved
// its config yet still gets a valid hooks.json.
const AWB_DEFAULTS: Omit<AwbConfig, "hooks"> = {
	host: "127.0.0.1",
	port: 8890,
	maxBodyBytes: 1024 * 1024,
	publicBaseUrl: null,
};

function awbConfigFile(): string {
	return path.join(process.env.AWB_HOME ?? path.join(os.homedir(), ".agent-webhook-bridge"), "hooks.json");
}

function loadAwbConfig(): AwbConfig {
	let fileCfg: Partial<AwbConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(awbConfigFile(), "utf8")) as Partial<AwbConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	return { ...AWB_DEFAULTS, ...fileCfg, hooks: { ...(fileCfg.hooks ?? {}) } };
}

export class HookExistsError extends Error {}

export interface LocalHookInfo {
	/** false when the URL doesn't point at this machine's awb broker. */
	local: boolean;
	found?: boolean;
	name?: string;
	hasWorkdir?: boolean;
}

/**
 * Looks a hook URL up in the local awb config, so registration can warn
 * about hooks that don't exist or lack a workdir (a workdir-less hook runs
 * in whatever folder the broker was started from, which moves its Claude
 * sessions — and its project context — across broker restarts). Remote URLs
 * come back `local: false` and are never judged: phase 2 nodes manage their
 * own hooks.
 */
export function inspectLocalHook(hookUrl: string): LocalHookInfo {
	let url: URL;
	try {
		url = new URL(hookUrl);
	} catch {
		return { local: false };
	}
	const cfg = loadAwbConfig();
	const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (!loopback.has(url.hostname) || Number(url.port || 80) !== cfg.port) return { local: false };
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== "hook" || !parts[1]) return { local: false };
	const name = decodeURIComponent(parts[1]);
	const hook = cfg.hooks[name];
	if (!hook) return { local: true, found: false, name };
	return { local: true, found: true, name, hasWorkdir: typeof hook.workdir === "string" && hook.workdir !== "" };
}

export const PUBLISHABLE_PERMISSION_MODES = ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"] as const;
export type PublishablePermissionMode = (typeof PUBLISHABLE_PERMISSION_MODES)[number];

export interface HookSandbox {
	kind: "docker";
	image: string;
}

export interface HookRuntime {
	/** Harness the hook spawns, from its `consumers` list (`spawn:claude` → "claude"). */
	harness: string | null;
	/** Directory the harness runs in — where its sessions can be resumed from. */
	workdir: string | null;
	/** null = host sandbox; set when the hook runs inside docker. */
	sandbox: HookSandbox | null;
	permissionMode: PublishablePermissionMode | null;
	/** Prompt template from the awb hook, when readable locally. */
	promptTemplate: string | null;
}

/**
 * How the hook runs its jobs. Only answerable for hooks on this machine's
 * broker; remote hooks (phase 2) come back all-null. The workdir is a local
 * path, which is fine to expose while the hub is local-only.
 */
export function hookRuntime(hookUrl: string): HookRuntime {
	const empty: HookRuntime = { harness: null, workdir: null, sandbox: null, permissionMode: null, promptTemplate: null };
	const info = inspectLocalHook(hookUrl);
	if (!info.local || !info.found || !info.name) return empty;
	const hook = loadAwbConfig().hooks[info.name];
	const consumers = Array.isArray(hook?.consumers) ? (hook.consumers as unknown[]) : [];
	let harness: string | null = null;
	for (const consumer of consumers) {
		if (typeof consumer === "string" && consumer.startsWith("spawn:")) {
			harness = consumer.slice("spawn:".length);
			break;
		}
	}
	const workdir = typeof hook?.workdir === "string" && hook.workdir !== "" ? hook.workdir : null;
	const block = hook?.sandbox as { kind?: unknown; image?: unknown } | undefined;
	const sandbox =
		block?.kind === "docker" && typeof block.image === "string" && block.image !== ""
			? { kind: "docker" as const, image: block.image }
			: null;
	const mode = hook?.permissionMode;
	const permissionMode =
		typeof mode === "string" && PUBLISHABLE_PERMISSION_MODES.includes(mode as PublishablePermissionMode)
			? (mode as PublishablePermissionMode)
			: null;
	const promptTemplate =
		typeof hook?.promptTemplate === "string" && hook.promptTemplate.trim() !== "" ? hook.promptTemplate : null;
	return { harness, workdir, sandbox, permissionMode, promptTemplate };
}

/** POSIX single-quoting for shell commands built from DB-derived values. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell command that reopens a harness session in a terminal. Resume mechanics
 * differ by runner — claude by uuid, free-code by .jsonl path, cursor by chat
 * uuid with `--workspace`.
 */
const HARNESS_RESUME_COMMANDS: Record<string, (sessionId: string, workdir: string | null) => string | null> = {
	claude: (sessionId) => `claude --resume ${shellQuote(sessionId)}`,
	"free-code": (sessionId) => `free-code --session ${shellQuote(sessionId)} --no-rag-server`,
	cursor: (sessionId, workdir) =>
		workdir
			? `agent --resume ${shellQuote(sessionId)} --trust --approve-mcps --workspace ${shellQuote(workdir)}`
			: null,
};

/** Command to resume `sessionId` under `harness`, or null when unknown. */
export function harnessResumeCommand(
	harness: string | null,
	sessionId: string | null,
	workdir: string | null = null,
): string | null {
	if (!harness || !sessionId) return null;
	return HARNESS_RESUME_COMMANDS[harness]?.(sessionId, workdir) ?? null;
}

const HARNESS_RESUME_ENV: Record<string, Record<string, string>> = {
	"free-code": { FREE_CODE_STARTUP_PROFILE: "default" },
};

/** The resume-time environment for `harness` ({} when it needs none). */
export function harnessResumeEnv(harness: string | null): Record<string, string> {
	return (harness && HARNESS_RESUME_ENV[harness]) || {};
}

/**
 * Runtimes a hook can spawn. The hub writes `spawn:<runner>` into the hook's
 * `consumers` list; awb's dispatch selects the matching adapter. Both share
 * the same hook protocol (secret, `callbackUrl`, `sessionId`), so the hub
 * and callers stay runtime-agnostic — only the spawned binary and the
 * session-id shape differ (a claude uuid vs. a free-code `.jsonl` path).
 */
export const PUBLISHABLE_RUNNERS = ["claude", "free-code", "cursor"] as const;
export type PublishableRunner = (typeof PUBLISHABLE_RUNNERS)[number];

/** CLI binary each runner id maps to on PATH (`cursor` → `agent`). */
export const RUNNER_BINARIES: Record<PublishableRunner, string> = {
	claude: "claude",
	"free-code": "free-code",
	cursor: "agent",
};

export function runnerBinary(runner: PublishableRunner): string {
	return RUNNER_BINARIES[runner] ?? runner;
}

export const _impl = { spawnSync: cp.spawnSync };

/** Which runners are installed on this host (`<binary> --version`). */
export function availableRunners(): { id: PublishableRunner; installed: boolean }[] {
	return PUBLISHABLE_RUNNERS.map((id) => {
		const result = _impl.spawnSync(runnerBinary(id), ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return { id, installed: result.status === 0 };
	});
}

export const PUBLISHABLE_SANDBOXES = ["host", "docker"] as const;
export type PublishableSandbox = (typeof PUBLISHABLE_SANDBOXES)[number];

/** Default docker image per runner when the publish form leaves image empty. */
export const DEFAULT_SANDBOX_IMAGES: Record<PublishableRunner, string> = {
	claude: "target-agent:latest",
	"free-code": "target-agent-freecode:latest",
	cursor: "target-agent-cursor:latest",
};

export function defaultSandboxImage(runner: PublishableRunner = "claude"): string {
	return DEFAULT_SANDBOX_IMAGES[runner] ?? DEFAULT_SANDBOX_IMAGES.claude;
}

const DOCKER_PROBE_TTL_MS = 60_000;
let dockerProbe: { available: boolean; at: number } | null = null;

export function dockerAvailable(): boolean {
	const now = Date.now();
	if (dockerProbe && now - dockerProbe.at < DOCKER_PROBE_TTL_MS) return dockerProbe.available;
	const result = _impl.spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	});
	const available = result.status === 0;
	dockerProbe = { available, at: now };
	return available;
}

export function availableSandboxes(): { id: PublishableSandbox; available: boolean }[] {
	return PUBLISHABLE_SANDBOXES.map((id) => ({ id, available: id === "docker" ? dockerAvailable() : true }));
}

export interface HookOptions {
	/** Custom shared secret; autogenerated when omitted. */
	secret?: string;
	permissionMode?: PublishablePermissionMode;
	/** Which CLI the hook spawns. Defaults to `"claude"`. */
	runner?: PublishableRunner;
	/** Where that CLI runs. Defaults to `"host"`, which writes no sandbox block. */
	sandbox?: PublishableSandbox;
	/** Image for `sandbox: "docker"`; defaults to the runner's default image. */
	image?: string;
}

/**
 * Registers a new trigger hook in awb and returns what the hub needs to
 * point an agent at it. Creates the workdir if it doesn't exist yet.
 */
export function createAwbHook(
	name: string,
	workdir: string,
	promptTemplate: string,
	options: HookOptions = {},
): { hookUrl: string; secret: string } {
	const cfg = loadAwbConfig();
	if (cfg.hooks[name]) throw new HookExistsError(`awb hook '${name}' already exists`);

	const secret = options.secret ?? crypto.randomBytes(24).toString("hex");
	const runner = options.runner ?? "claude";
	fs.mkdirSync(workdir, { recursive: true });
	cfg.hooks[name] = {
		mode: "trigger",
		consumers: [`spawn:${runner}`],
		secret,
		promptTemplate,
		workdir,
		...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
		...(options.sandbox === "docker"
			? { sandbox: { kind: "docker", image: options.image || defaultSandboxImage(runner) } }
			: {}),
	};
	const file = awbConfigFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

	return { hookUrl: `http://${cfg.host}:${cfg.port}/hook/${encodeURIComponent(name)}`, secret };
}
