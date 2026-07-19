#!/usr/bin/env node
/**
 * `mesh` — CLI for the AgentMesh hub: register agents, submit jobs, and
 * follow them to completion without the web UI (PLAN.md section 8, step 2:
 * "mesh submit cierra el loop completo por terminal").
 *
 * Agent commands write to the hub's SQLite directly (same pattern as awb's
 * CLI editing hooks.json): no admin token needed locally, and the daemon
 * reads per request so changes apply without a restart. `submit`/`jobs` go
 * through the HTTP API instead, since submitting is what remote users will
 * do and this exercises the same path.
 */
import { inspectLocalHook } from "./awb.ts";
import { loadConfig } from "./config.ts";
import {
	type Agent,
	createApiKey,
	deleteAgent,
	deleteApiKey,
	getAgent,
	listAgents,
	listApiKeys,
	parseDurationMs,
	saveAgent,
} from "./db.ts";
import { startHub } from "./daemon.ts";

const VALID_NAME = /^[A-Za-z0-9._-]+$/;
const POLL_INTERVAL_MS = 2000;

function usage(): void {
	console.log(`Usage: mesh <command> [args]

Commands:
  start                                  Run the hub (foreground)
  add-agent <name> [options]             Register (or update) an agent
    --hook-url <url>                     awb hook URL the agent lives behind (required)
    --secret <s>                         X-Webhook-Secret of that hook (required)
    --description <text>                 What the agent does (shown in the UI)
    --owner <name>                       Who operates it
    --tag <t>                            Repeatable
    --disabled                           Register it hidden from job submission
  rm-agent <name>                        Remove an agent
  list                                   List agents
  submit <agent> [--session-id <id>] <input...>
                                          Submit a job and wait for its result
                                          (with --session-id, the agent resumes that
                                          session instead of starting fresh — every
                                          finished job prints/stores the session id to
                                          continue from; claude sessions are uuids,
                                          free-code sessions are .jsonl paths)
  jobs                                   Show recent jobs
  add-key <name> [options]               Create (or rotate) an API key for a remote
                                          user — the key is printed once, only its
                                          hash is stored
    --expires <dur>                      Key expires after <dur>: <n>m, <n>h or <n>d
                                          (e.g. 30m, 12h, 7d); default: never
    --max-uses <N>                       Accepted remote jobs before the key stops
                                          working (1 = single use); default: unlimited
  list-keys                              List API keys: owner, expiry and uses left
                                          (never the keys)
  rm-key <name>                          Revoke an API key
`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i === -1 || i === args.length - 1) return undefined;
	return args[i + 1];
}

function flagValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
	}
	return out;
}

function describeAgent(agent: Agent): string {
	return [
		`Agent '${agent.name}'${agent.enabled ? "" : " [disabled]"}`,
		agent.description ? `Description: ${agent.description}` : "",
		`Hook URL:    ${agent.hookUrl}`,
		agent.owner ? `Owner:       ${agent.owner}` : "",
		agent.tags.length > 0 ? `Tags:        ${agent.tags.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const [, , cmd, ...rest] = process.argv;

	if (!cmd || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "start") {
		startHub();
		return;
	}

	const cfg = loadConfig();
	const apiBase = `http://${cfg.host}:${cfg.port}/api`;

	if (cmd === "list") {
		const agents = listAgents();
		if (agents.length === 0) {
			console.log("No agents registered. Use `mesh add-agent <name>`.");
			return;
		}
		for (const agent of agents) console.log(`${describeAgent(agent)}\n`);
		return;
	}

	if (cmd === "add-agent") {
		const name = rest[0];
		if (!name || !VALID_NAME.test(name)) {
			console.error("Invalid or missing name. Allowed: A-Z a-z 0-9 . _ -");
			process.exitCode = 1;
			return;
		}
		const hookUrl = flagValue(rest, "--hook-url");
		const secret = flagValue(rest, "--secret");
		if (!hookUrl || !secret) {
			console.error("--hook-url and --secret are required (both come from `awb add`/`awb url`).");
			process.exitCode = 1;
			return;
		}
		const agent = saveAgent({
			name,
			hookUrl,
			secret,
			description: flagValue(rest, "--description") ?? "",
			owner: flagValue(rest, "--owner") ?? "",
			tags: flagValues(rest, "--tag"),
			enabled: !rest.includes("--disabled"),
		});
		console.log(describeAgent(agent));
		const info = inspectLocalHook(hookUrl);
		if (info.local && info.found === false) {
			console.warn(`\n⚠ No hook named '${info.name}' exists in the local awb — jobs will fail until you create it.`);
		} else if (info.local && info.found && !info.hasWorkdir) {
			console.warn(
				`\n⚠ Hook '${info.name}' has no workdir: it runs in the broker's folder and its sessions can be lost across restarts. Recreate it with --workdir.`,
			);
		}
		return;
	}

	if (cmd === "rm-agent") {
		const name = rest[0];
		if (!name || !deleteAgent(name)) {
			console.error(`Agent '${name}' does not exist.`);
			process.exitCode = 1;
			return;
		}
		console.log(`Agent '${name}' removed.`);
		return;
	}

	if (cmd === "add-key") {
		const name = rest[0];
		if (!name || !VALID_NAME.test(name)) {
			console.error("Invalid or missing name. Allowed: A-Z a-z 0-9 . _ -");
			process.exitCode = 1;
			return;
		}
		const expiresSpec = flagValue(rest, "--expires");
		let expiresAt: string | null = null;
		if (expiresSpec !== undefined) {
			const ms = parseDurationMs(expiresSpec);
			if (ms == null) {
				console.error(`Invalid --expires '${expiresSpec}'. Use <number><m|h|d>, e.g. 30m, 12h, 7d.`);
				process.exitCode = 1;
				return;
			}
			expiresAt = new Date(Date.now() + ms).toISOString();
		}
		const maxUsesSpec = flagValue(rest, "--max-uses");
		let maxUses: number | null = null;
		if (maxUsesSpec !== undefined) {
			if (!/^[0-9]+$/.test(maxUsesSpec) || Number(maxUsesSpec) <= 0) {
				console.error(`Invalid --max-uses '${maxUsesSpec}'. Must be a positive integer (1 = single use).`);
				process.exitCode = 1;
				return;
			}
			maxUses = Number(maxUsesSpec);
		}
		const { key } = createApiKey(name, { expiresAt, maxUses });
		console.log(`API key for '${name}' — save it now, it cannot be shown again (only its hash is stored):\n\n  ${key}\n`);
		console.log(`Expires:   ${expiresAt ?? "never"}`);
		console.log(`Max uses:  ${maxUses ?? "unlimited"}`);
		console.log(`The user submits jobs with:  Authorization: Bearer ${key.slice(0, 6)}…`);
		return;
	}

	if (cmd === "list-keys") {
		const keys = listApiKeys();
		if (keys.length === 0) {
			console.log("No API keys. Use `mesh add-key <name>`.");
			return;
		}
		for (const k of keys) {
			console.log(
				`${k.name}  created=${k.createdAt}  expires=${k.expiresAt ?? "never"}  uses-left=${k.usesLeft ?? "unlimited"}`,
			);
		}
		return;
	}

	if (cmd === "rm-key") {
		const name = rest[0];
		if (!name || !deleteApiKey(name)) {
			console.error(`API key '${name}' does not exist.`);
			process.exitCode = 1;
			return;
		}
		console.log(`API key '${name}' revoked.`);
		return;
	}

	if (cmd === "submit") {
		const [agentName, ...inputParts] = rest;
		const sessionId = flagValue(inputParts, "--session-id");
		if (sessionId) inputParts.splice(inputParts.indexOf("--session-id"), 2);
		const input = inputParts.join(" ").trim();
		if (!agentName || !getAgent(agentName) || !input) {
			console.error("Usage: mesh submit <agent> [--session-id <id>] <input...> (agent must exist — see `mesh list`).");
			process.exitCode = 1;
			return;
		}

		let job: { id: string; status: string; result: string | null; error: string | null; sessionId: string | null };
		try {
			const res = await fetch(`${apiBase}/jobs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: agentName, input, ...(sessionId ? { sessionId } : {}) }),
			});
			const data = (await res.json()) as { job?: typeof job; error?: string };
			if (!res.ok || !data.job) {
				console.error(`Hub rejected the job: ${data.error ?? res.status}`);
				process.exitCode = 1;
				return;
			}
			job = data.job;
		} catch (err) {
			console.error(`Could not reach the hub at ${apiBase}. Is it running (\`mesh start\`)? ${String(err)}`);
			process.exitCode = 1;
			return;
		}

		console.log(`Job ${job.id} submitted to '${agentName}'. Waiting for the result...`);
		while (job.status === "pending" || job.status === "running") {
			await sleep(POLL_INTERVAL_MS);
			const res = await fetch(`${apiBase}/jobs/${job.id}`);
			job = ((await res.json()) as { job: typeof job }).job;
		}

		if (job.status === "done") {
			console.log(`\n${job.result ?? "(empty result)"}`);
			if (job.sessionId) {
				console.log(`\n(session: ${job.sessionId} — continue it with --session-id)`);
			}
		} else {
			console.error(`\nJob failed: ${job.error ?? "unknown error"}`);
			process.exitCode = 1;
		}
		return;
	}

	if (cmd === "jobs") {
		try {
			const res = await fetch(`${apiBase}/jobs`);
			const { jobs } = (await res.json()) as {
				jobs: { id: string; agent: string; status: string; createdAt: string; error: string | null }[];
			};
			if (jobs.length === 0) {
				console.log("No jobs yet. Use `mesh submit <agent> <input...>`.");
				return;
			}
			for (const j of jobs) {
				console.log(`${j.id} '${j.agent}' ${j.status} created=${j.createdAt}${j.error ? ` error=${j.error}` : ""}`);
			}
		} catch (err) {
			console.error(`Could not reach the hub at ${apiBase}. Is it running (\`mesh start\`)? ${String(err)}`);
			process.exitCode = 1;
		}
		return;
	}

	usage();
	process.exitCode = 1;
}

main();
