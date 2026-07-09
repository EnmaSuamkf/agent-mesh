/**
 * Dispatches a job to its agent's awb hook. The hook answers `{ok:true}`
 * immediately (the Claude run happens in the background), so a successful
 * POST only means "accepted" → job goes `running`. The run's outcome arrives
 * later on `POST /api/jobs/:id/result` via the `callbackUrl` we send in the
 * event body (awb only accepts loopback callback URLs in this phase, which
 * matches the hub's local-only default).
 */
import type { HubConfig } from "./config.ts";
import type { Agent, Job } from "./db.ts";
import { completeJob, markJobRunning } from "./db.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const DISPATCH_TIMEOUT_MS = 10_000;

export async function dispatchJob(job: Job, agent: Agent, cfg: HubConfig, log: Logger): Promise<void> {
	const callbackUrl = `http://${cfg.host}:${cfg.port}/api/jobs/${job.id}/result?token=${job.callbackToken}`;
	try {
		const res = await fetch(agent.hookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-secret": agent.secret,
				// awb resumes that Claude session (`claude --resume`) instead of
				// starting a fresh one when this header is present.
				...(job.resumeSessionId ? { sessionid: job.resumeSessionId } : {}),
			},
			body: JSON.stringify({ jobId: job.id, input: job.input, callbackUrl }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});
		if (res.ok) {
			markJobRunning(job.id);
			log(`job ${job.id} -> '${agent.name}' accepted`);
		} else {
			completeJob(job.id, { ok: false, error: `hook answered ${res.status}` });
			log(`job ${job.id} -> '${agent.name}' rejected (${res.status})`, "error");
		}
	} catch (err) {
		completeJob(job.id, { ok: false, error: `hook unreachable: ${String(err)}` });
		log(`job ${job.id} -> '${agent.name}' unreachable: ${String(err)}`, "error");
	}
}
