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
	hookRuntime,
	inspectLocalHook,
	PUBLISHABLE_PERMISSION_MODES,
	type PublishablePermissionMode,
} from "./awb.ts";
import type { HubConfig } from "./config.ts";
import type { Agent, Job } from "./db.ts";
import {
	completeJob,
	createApiKey,
	deleteAgent,
	deleteApiKey,
	deleteJob,
	deleteJobs,
	expireStaleJobs,
	findApiKeyOwner,
	getAgent,
	getJob,
	insertJob,
	listAgents,
	listApiKeys,
	listJobs,
	saveAgent,
} from "./db.ts";
import { dispatchJob, type Logger } from "./runner.ts";

const UI_FILE = path.join(import.meta.dirname, "ui", "index.html");

// Basic per-key rate limit for remote submissions (phase 2): sliding window,
// in memory — restarting the hub resets it, which is fine at this scale.
const RATE_LIMIT_MAX_JOBS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const recentSubmissions = new Map<string, number[]>();

/** Records one submission for `keyName`; false when the key is over its budget. */
function underRateLimit(keyName: string): boolean {
	const now = Date.now();
	const recent = (recentSubmissions.get(keyName) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	if (recent.length >= RATE_LIMIT_MAX_JOBS) {
		recentSubmissions.set(keyName, recent);
		return false;
	}
	recent.push(now);
	recentSubmissions.set(keyName, recent);
	return true;
}

/**
 * Remote = the request came in through the tunnel (or any non-loopback
 * socket). cloudflared proxies from this same machine, so the socket address
 * alone can't tell tunnel traffic apart — but cloudflared always adds
 * forwarding headers (cf-connecting-ip / x-forwarded-for) that a remote
 * client cannot strip. A local caller faking those headers only subjects
 * itself to the stricter remote rules, so they can't be used to bypass auth.
 */
function isRemoteRequest(req: http.IncomingMessage): boolean {
	const addr = req.socket.remoteAddress ?? "";
	const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
	if (!loopback) return true;
	return req.headers["cf-connecting-ip"] != null || req.headers["x-forwarded-for"] != null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

function bearerToken(headers: http.IncomingHttpHeaders): string {
	return String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function isAdmin(cfg: HubConfig, headers: http.IncomingHttpHeaders): boolean {
	const provided = bearerToken(headers);
	return provided.length > 0 && timingSafeEqualStr(provided, cfg.adminToken);
}

/** What the public API exposes about an agent — never the secret or hook URL. */
function publicAgent(agent: Agent): Record<string, unknown> {
	const runtime = hookRuntime(agent.hookUrl);
	return {
		name: agent.name,
		description: agent.description,
		owner: agent.owner,
		tags: agent.tags,
		enabled: agent.enabled,
		createdAt: agent.createdAt,
		harness: runtime.harness,
		workdir: runtime.workdir,
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
		resumeSessionId: job.resumeSessionId,
		submittedBy: job.submittedBy,
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
		// One malformed request must never take the whole hub down — especially
		// now that it can be reached remotely through the tunnel. Anything the
		// per-route code throws (a bad URL host, un-decodable %-escapes in a
		// path segment, etc.) is caught here and answered with 400 instead of
		// crashing the process on an uncaught exception.
		try {
			handleRequest(cfg, log, req, res);
		} catch (err) {
			log(`request handler error: ${String(err)}`, "error");
			if (!res.headersSent) sendJson(res, 400, { error: "bad_request" });
			else res.end();
		}
	});
}

function handleRequest(cfg: HubConfig, log: Logger, req: http.IncomingMessage, res: http.ServerResponse): void {
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
				// Registration succeeds either way; the warning is advisory.
				let warning: string | undefined;
				const info = inspectLocalHook(hookUrl);
				if (info.local && info.found === false) {
					warning = `no hook named '${info.name}' exists in the local awb — jobs will fail until you create it`;
				} else if (info.local && info.found && !info.hasWorkdir) {
					warning = `hook '${info.name}' has no workdir: it runs in the broker's folder and its Claude sessions can be lost across restarts — recreate it with --workdir`;
				}
				log(`agent '${name}' registered${warning ? ` (warning: ${warning})` : ""}`);
				sendJson(res, 200, { agent: publicAgent(agent), ...(warning ? { warning } : {}) });
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
						error: `invalid permissionMode (allowed: ${PUBLISHABLE_PERMISSION_MODES.join(", ")})`,
					});
					return;
				}
				// bypassPermissions gives job submitters arbitrary command execution on
				// this machine; it must be opted into explicitly, not just selected.
				if (body.permissionMode === "bypassPermissions" && body.acceptBypassRisk !== true) {
					sendJson(res, 400, {
						error:
							"bypassPermissions disables every permission check: anyone who can submit a job can run arbitrary commands on this machine. Send acceptBypassRisk: true to confirm you want that.",
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
			// Local (loopback) submissions keep working without credentials:
			// the UI, the CLI and the loop listeners all live on this machine.
			// Anything that came through the tunnel must present an API key.
			let submittedBy: string | undefined;
			if (isRemoteRequest(req)) {
				const owner = findApiKeyOwner(bearerToken(req.headers));
				if (!owner) {
					sendJson(res, 401, {
						error: "unauthorized",
						hint: "remote job submission requires a valid API key: Authorization: Bearer <key>",
					});
					return;
				}
				if (!underRateLimit(owner)) {
					sendJson(res, 429, {
						error: "rate_limited",
						hint: `max ${RATE_LIMIT_MAX_JOBS} jobs per minute per key — wait and retry`,
					});
					return;
				}
				submittedBy = owner;
			}
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
				let resumeSessionId: string | undefined;
				if (typeof body.sessionId === "string" && body.sessionId.trim() !== "") {
					resumeSessionId = body.sessionId.trim();
					// It travels as an HTTP header to awb — keep it to a sane id shape.
					if (!/^[A-Za-z0-9-]{8,64}$/.test(resumeSessionId)) {
						sendJson(res, 400, { error: "invalid sessionId" });
						return;
					}
				}
				const job = insertJob(agent.name, input, resumeSessionId, submittedBy);
				// Answer right away with the pending job; dispatch runs in the
				// background and the caller polls GET /api/jobs/:id.
				void dispatchJob(job, agent, cfg, log);
				sendJson(res, 202, { job: publicJob(job) });
			});
			return;
		}
	}

	// --- /api/keys (admin only; phase 2 remote submitters) ---

	if (parts[1] === "keys" && !parts[2]) {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		if (req.method === "GET") {
			sendJson(res, 200, { keys: listApiKeys() });
			return;
		}
		if (req.method === "POST") {
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const name = typeof body.name === "string" ? body.name : "";
				if (!/^[A-Za-z0-9._-]+$/.test(name)) {
					sendJson(res, 400, { error: "name is required (allowed: A-Z a-z 0-9 . _ -)" });
					return;
				}
				const created = createApiKey(name);
				// The key itself is never logged and never retrievable again.
				log(`api key '${name}' created`);
				sendJson(res, 200, {
					...created,
					note: "save this key now — only its hash is stored, it cannot be shown again",
				});
			});
			return;
		}
	}

	if (parts[1] === "keys" && parts[2] && req.method === "DELETE") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const name = decodeURIComponent(parts[2]);
		if (!deleteApiKey(name)) {
			sendJson(res, 404, { error: "unknown_key", name });
			return;
		}
		log(`api key '${name}' revoked`);
		sendJson(res, 200, { ok: true });
		return;
	}

	// Batch delete debe estar antes de las rutas genéricas con parts[2]
	if (parts[1] === "jobs" && parts[2] === "batch-delete" && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
			if (ids.length === 0) {
				sendJson(res, 400, { error: "ids array is required" });
				return;
			}
			const deleted = deleteJobs(ids);
			log(`deleted ${deleted} job(s)`);
			sendJson(res, 200, { ok: true, deleted });
		});
		return;
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

	if (parts[1] === "jobs" && parts[2] && !parts[3] && req.method === "DELETE") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const id = parts[2];
		if (!deleteJob(id)) {
			sendJson(res, 404, { error: "unknown_job", id });
			return;
		}
		log(`job ${id} deleted`);
		sendJson(res, 200, { ok: true });
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
}
