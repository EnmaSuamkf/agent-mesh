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
import { loadConfig } from "./config.ts";
import { type Agent, deleteAgent, getAgent, listAgents, saveAgent } from "./db.ts";
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
  submit <agent> <input...>              Submit a job and wait for its result
  jobs                                   Show recent jobs
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

	if (cmd === "submit") {
		const [agentName, ...inputParts] = rest;
		const input = inputParts.join(" ").trim();
		if (!agentName || !getAgent(agentName) || !input) {
			console.error("Usage: mesh submit <agent> <input...> (agent must exist — see `mesh list`).");
			process.exitCode = 1;
			return;
		}

		let job: { id: string; status: string; result: string | null; error: string | null };
		try {
			const res = await fetch(`${apiBase}/jobs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: agentName, input }),
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
