/**
 * HTTP listener for the hub: JSON API + the UI's static page.
 *
 * Routes:
 *   GET    /health                 → liveness
 *   GET    /api/agents             → public agent list (no secrets, no hook URLs)
 *   POST   /api/agents             → register/update an agent (admin token)
 *   POST   /api/publish            → create the awb hook AND register the agent
 *                                     in one step (admin token; local awb only)
 *   DELETE /api/agents/:name       → remove an agent (admin token)
 *   GET    /api/jobs               → recent jobs
 *   POST   /api/jobs               → submit { agent, input }, answers with the job
 *   GET    /api/jobs/:id           → job status + result (UI/CLI poll this)
 *   POST   /api/jobs/:id/result    → awb's result callback (?token=<per-job token>)
 *   GET    /                       → ui/index.html
 *
 * Job reads run lazy expiry first (see db.ts), so a job whose callback never
 * arrives shows up as failed/timeout instead of hanging in `running` forever.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAwbHook,
	HookExistsError,
	PUBLISHABLE_PERMISSION_MODES,
	type PublishablePermissionMode,
} from "./awb.ts";
import type { HubConfig } from "./config.ts";
import type { Agent, Job } from "./db.ts";
import {
	completeJob,
	deleteAgent,
	expireStaleJobs,
	getAgent,
	getJob,
	insertJob,
	listAgents,
	listJobs,
	saveAgent,
} from "./db.ts";
import { dispatchJob, type Logger } from "./runner.ts";

const UI_FILE = path.join(import.meta.dirname, "ui", "index.html");

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

function isAdmin(cfg: HubConfig, headers: http.IncomingHttpHeaders): boolean {
	const provided = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
	return provided.length > 0 && timingSafeEqualStr(provided, cfg.adminToken);
}

/** What the public API exposes about an agent — never the secret or hook URL. */
function publicAgent(agent: Agent): Record<string, unknown> {
	return {
		name: agent.name,
		description: agent.description,
		owner: agent.owner,
		tags: agent.tags,
		enabled: agent.enabled,
		createdAt: agent.createdAt,
	};
}

/** What the public API exposes about a job — never the callback token. */
function publicJob(job: Job): Record<string, unknown> {
	return {
		id: job.id,
		agent: job.agent,
		input: job.input,
		status: job.status,
		result: job.result,
		error: job.error,
		sessionId: job.sessionId,
		createdAt: job.createdAt,
		finishedAt: job.finishedAt,
	};
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function readJsonBody(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	maxBytes: number,
	onBody: (body: Record<string, unknown>) => void,
): void {
	const chunks: Buffer[] = [];
	let size = 0;
	let aborted = false;
	req.on("data", (chunk: Buffer) => {
		if (aborted) return;
		size += chunk.length;
		if (size > maxBytes) {
			aborted = true;
			sendJson(res, 413, { error: "payload_too_large" });
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (aborted) return;
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			if (typeof body !== "object" || body === null) throw new Error("not an object");
			onBody(body as Record<string, unknown>);
		} catch {
			sendJson(res, 400, { error: "invalid_json" });
		}
	});
	req.on("error", () => {
		if (!aborted) sendJson(res, 400, { error: "bad_request" });
	});
}

export function createServer(cfg: HubConfig, log: Logger): http.Server {
	return http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const parts = url.pathname.split("/").filter(Boolean);

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { ok: true, agents: listAgents().length });
			return;
		}

		if (req.method === "GET" && url.pathname === "/") {
			try {
				const html = fs.readFileSync(UI_FILE);
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(html);
			} catch {
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end("agentmesh-hub is running. The web UI isn't built yet — use the API or the `mesh` CLI.");
			}
			return;
		}

		if (parts[0] !== "api") {
			sendJson(res, 404, { error: "not_found" });
			return;
		}

		// --- /api/agents ---

		if (parts[1] === "agents" && !parts[2]) {
			if (req.method === "GET") {
				sendJson(res, 200, { agents: listAgents().map(publicAgent) });
				return;
			}
			if (req.method === "POST") {
				if (!isAdmin(cfg, req.headers)) {
					sendJson(res, 401, { error: "unauthorized" });
					return;
				}
				readJsonBody(req, res, cfg.maxInputBytes, (body) => {
					const name = typeof body.name === "string" ? body.name : "";
					const hookUrl = typeof body.hookUrl === "string" ? body.hookUrl : "";
					const secret = typeof body.secret === "string" ? body.secret : "";
					if (!/^[A-Za-z0-9._-]+$/.test(name) || !hookUrl || !secret) {
						sendJson(res, 400, { error: "name, hookUrl and secret are required" });
						return;
					}
					const agent = saveAgent({
						name,
						hookUrl,
						secret,
						description: typeof body.description === "string" ? body.description : "",
						owner: typeof body.owner === "string" ? body.owner : "",
						tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
						enabled: body.enabled !== false,
					});
					log(`agent '${name}' registered`);
					sendJson(res, 200, { agent: publicAgent(agent) });
				});
				return;
			}
		}

		if (parts[1] === "publish" && !parts[2] && req.method === "POST") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const name = typeof body.name === "string" ? body.name : "";
				if (!/^[A-Za-z0-9._-]+$/.test(name)) {
					sendJson(res, 400, { error: "invalid name (allowed: A-Z a-z 0-9 . _ -)" });
					return;
				}
				if (getAgent(name)) {
					sendJson(res, 409, { error: "agent_exists", name });
					return;
				}
				const workdir =
					typeof body.workdir === "string" && body.workdir.trim() !== ""
						? body.workdir.replace(/^~(?=\/|$)/, os.homedir())
						: path.join(os.homedir(), "agentmesh-sandbox");
				const promptTemplate =
					typeof body.promptTemplate === "string" && body.promptTemplate.trim() !== ""
						? body.promptTemplate
						: "Sos un agente de AgentMesh. Tarea recibida:\n\n{{payload}}\n\nRealizá la tarea y respondé con el resultado final.";
				// Without {{payload}} the submitted task would never reach the prompt.
				if (!promptTemplate.includes("{{payload}}")) {
					sendJson(res, 400, { error: "promptTemplate must contain {{payload}}" });
					return;
				}
				const customSecret =
					typeof body.secret === "string" && body.secret.trim() !== "" ? body.secret.trim() : undefined;
				let permissionMode: PublishablePermissionMode | undefined;
				if (typeof body.permissionMode === "string" && body.permissionMode !== "") {
					if (!PUBLISHABLE_PERMISSION_MODES.includes(body.permissionMode as PublishablePermissionMode)) {
						sendJson(res, 400, {
							error: `invalid permissionMode (allowed: ${PUBLISHABLE_PERMISSION_MODES.join(", ")}; bypassPermissions is CLI-only on purpose)`,
						});
						return;
					}
					permissionMode = body.permissionMode as PublishablePermissionMode;
				}

				let hook: { hookUrl: string; secret: string };
				try {
					hook = createAwbHook(name, workdir, promptTemplate, { secret: customSecret, permissionMode });
				} catch (err) {
					if (err instanceof HookExistsError) {
						sendJson(res, 409, { error: "hook_exists", name });
						return;
					}
					log(`publish '${name}': could not create awb hook: ${String(err)}`, "error");
					sendJson(res, 500, { error: "could not create the awb hook — is agent-webhook-bridge set up?" });
					return;
				}

				const agent = saveAgent({
					name,
					hookUrl: hook.hookUrl,
					secret: hook.secret,
					description: typeof body.description === "string" ? body.description : "",
					owner: typeof body.owner === "string" ? body.owner : "",
					tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
					enabled: true,
				});
				log(`agent '${name}' published (hook + registry)`);
				sendJson(res, 200, { agent: publicAgent(agent), workdir });
			});
			return;
		}

		if (parts[1] === "agents" && parts[2] && req.method === "DELETE") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			const name = decodeURIComponent(parts[2]);
			if (!deleteAgent(name)) {
				sendJson(res, 404, { error: "unknown_agent", name });
				return;
			}
			log(`agent '${name}' removed`);
			sendJson(res, 200, { ok: true });
			return;
		}

		// --- /api/jobs ---

		if (parts[1] === "jobs" && !parts[2]) {
			if (req.method === "GET") {
				expireStaleJobs(cfg.jobTimeoutMs);
				sendJson(res, 200, { jobs: listJobs().map(publicJob) });
				return;
			}
			if (req.method === "POST") {
				readJsonBody(req, res, cfg.maxInputBytes, (body) => {
					const agentName = typeof body.agent === "string" ? body.agent : "";
					const input = typeof body.input === "string" ? body.input.trim() : "";
					const agent = getAgent(agentName);
					if (!agent || !agent.enabled) {
						sendJson(res, 404, { error: "unknown_or_disabled_agent", agent: agentName });
						return;
					}
					if (!input) {
						sendJson(res, 400, { error: "input is required" });
						return;
					}
					const job = insertJob(agent.name, input);
					// Answer right away with the pending job; dispatch runs in the
					// background and the caller polls GET /api/jobs/:id.
					void dispatchJob(job, agent, cfg, log);
					sendJson(res, 202, { job: publicJob(job) });
				});
				return;
			}
		}

		if (parts[1] === "jobs" && parts[2] && !parts[3] && req.method === "GET") {
			expireStaleJobs(cfg.jobTimeoutMs);
			const job = getJob(parts[2]);
			if (!job) {
				sendJson(res, 404, { error: "unknown_job" });
				return;
			}
			sendJson(res, 200, { job: publicJob(job) });
			return;
		}

		if (parts[1] === "jobs" && parts[2] && parts[3] === "result" && req.method === "POST") {
			const job = getJob(parts[2]);
			const token = url.searchParams.get("token") ?? "";
			if (!job || !token || !timingSafeEqualStr(token, job.callbackToken)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, 4 * 1024 * 1024, (body) => {
				const ok = body.ok === true;
				// awb sends `result` as the string Claude produced; anything else
				// (missing on spawn failure, unexpected shape) is stringified.
				const result =
					body.result == null ? undefined : typeof body.result === "string" ? body.result : JSON.stringify(body.result);
				const error = ok
					? undefined
					: String(body.error ?? (body.exitCode != null ? `exit ${body.exitCode}` : "run failed"));
				// completeJob ignores jobs already done/failed, so a late callback
				// after a timeout doesn't resurrect the job — first writer wins.
				completeJob(job.id, {
					ok,
					result,
					error,
					sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
				});
				log(`job ${job.id} ${ok ? "done" : `failed (${error})`}`);
				sendJson(res, 200, { ok: true });
			});
			return;
		}

		sendJson(res, 404, { error: "not_found" });
	});
}
