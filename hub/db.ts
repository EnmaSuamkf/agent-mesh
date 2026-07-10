/**
 * Registry of agents + job queue (SQLite via node:sqlite, same zero-native-
 * deps approach as awb's broker). An agent is a pointer to an awb hook
 * (`hookUrl` + `secret`); a job is one task submitted to one agent, closed
 * asynchronously by awb's result callback.
 *
 * Job expiry is lazy on purpose: instead of a timer per job, every read path
 * first fails any pending/running job older than the configured timeout.
 * That survives hub restarts for free and the UI/CLI poll anyway.
 */
import * as crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { dbFile } from "./config.ts";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Agent {
	name: string;
	description: string;
	hookUrl: string;
	/** X-Webhook-Secret for the awb hook. Never returned by the public API. */
	secret: string;
	owner: string;
	tags: string[];
	enabled: boolean;
	createdAt: string;
}

export interface Job {
	id: string;
	agent: string;
	input: string;
	status: JobStatus;
	result: string | null;
	error: string | null;
	/** Claude session this run produced, reported by awb's callback. */
	sessionId: string | null;
	/** Claude session the caller asked to resume (forwarded to awb as the `sessionId` header). */
	resumeSessionId: string | null;
	/** Per-job token that authenticates awb's POST to /api/jobs/:id/result. */
	callbackToken: string;
	createdAt: string;
	finishedAt: string | null;
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
	if (db) return db;
	const file = dbFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	db = new DatabaseSync(file);
	// WAL: the `mesh` CLI writes to the same file while the hub daemon runs.
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			hook_url TEXT NOT NULL,
			secret TEXT NOT NULL,
			owner TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			agent TEXT NOT NULL,
			input TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			error TEXT,
			session_id TEXT,
			resume_session_id TEXT,
			callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			finished_at TEXT
		);
	`);
	// Migration for databases created before resume support; ALTER fails
	// harmlessly once the column exists.
	try {
		db.exec("ALTER TABLE jobs ADD COLUMN resume_session_id TEXT;");
	} catch {
		// Column already there.
	}
	return db;
}

function rowToAgent(row: Record<string, unknown>): Agent {
	return {
		name: String(row.name),
		description: String(row.description),
		hookUrl: String(row.hook_url),
		secret: String(row.secret),
		owner: String(row.owner),
		tags: JSON.parse(String(row.tags)),
		enabled: Number(row.enabled) === 1,
		createdAt: String(row.created_at),
	};
}

export function saveAgent(agent: Omit<Agent, "createdAt">): Agent {
	const createdAt = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO agents (name, description, hook_url, secret, owner, tags, enabled, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET description = excluded.description,
			   hook_url = excluded.hook_url, secret = excluded.secret,
			   owner = excluded.owner, tags = excluded.tags, enabled = excluded.enabled`,
		)
		.run(
			agent.name,
			agent.description,
			agent.hookUrl,
			agent.secret,
			agent.owner,
			JSON.stringify(agent.tags),
			agent.enabled ? 1 : 0,
			createdAt,
		);
	return { ...agent, createdAt };
}

export function deleteAgent(name: string): boolean {
	return open().prepare("DELETE FROM agents WHERE name = ?").run(name).changes > 0;
}

export function getAgent(name: string): Agent | null {
	const row = open().prepare("SELECT * FROM agents WHERE name = ?").get(name);
	return row ? rowToAgent(row as Record<string, unknown>) : null;
}

export function listAgents(): Agent[] {
	const rows = open().prepare("SELECT * FROM agents ORDER BY name").all();
	return (rows as Record<string, unknown>[]).map(rowToAgent);
}

function rowToJob(row: Record<string, unknown>): Job {
	return {
		id: String(row.id),
		agent: String(row.agent),
		input: String(row.input),
		status: row.status as JobStatus,
		result: row.result == null ? null : String(row.result),
		error: row.error == null ? null : String(row.error),
		sessionId: row.session_id == null ? null : String(row.session_id),
		resumeSessionId: row.resume_session_id == null ? null : String(row.resume_session_id),
		callbackToken: String(row.callback_token),
		createdAt: String(row.created_at),
		finishedAt: row.finished_at == null ? null : String(row.finished_at),
	};
}

export function insertJob(agent: string, input: string, resumeSessionId?: string): Job {
	const job: Job = {
		id: crypto.randomUUID(),
		agent,
		input,
		status: "pending",
		result: null,
		error: null,
		sessionId: null,
		resumeSessionId: resumeSessionId ?? null,
		callbackToken: crypto.randomBytes(24).toString("hex"),
		createdAt: new Date().toISOString(),
		finishedAt: null,
	};
	open()
		.prepare(
			"INSERT INTO jobs (id, agent, input, status, resume_session_id, callback_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run(job.id, job.agent, job.input, job.status, job.resumeSessionId, job.callbackToken, job.createdAt);
	return job;
}

export function markJobRunning(id: string): void {
	open().prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'pending'").run(id);
}

export function completeJob(
	id: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
): void {
	open()
		.prepare(
			`UPDATE jobs SET status = ?, result = ?, error = ?, session_id = ?, finished_at = ?
			 WHERE id = ? AND status IN ('pending', 'running')`,
		)
		.run(
			outcome.ok ? "done" : "failed",
			outcome.result ?? null,
			outcome.error ?? null,
			outcome.sessionId ?? null,
			new Date().toISOString(),
			id,
		);
}

export function expireStaleJobs(timeoutMs: number): void {
	const cutoff = new Date(Date.now() - timeoutMs).toISOString();
	open()
		.prepare(
			`UPDATE jobs SET status = 'failed', error = 'timeout', finished_at = ?
			 WHERE status IN ('pending', 'running') AND created_at < ?`,
		)
		.run(new Date().toISOString(), cutoff);
}

export function getJob(id: string): Job | null {
	const row = open().prepare("SELECT * FROM jobs WHERE id = ?").get(id);
	return row ? rowToJob(row as Record<string, unknown>) : null;
}

export function listJobs(limit = 50): Job[] {
	const rows = open().prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
	return (rows as Record<string, unknown>[]).map(rowToJob);
}

export function deleteJob(id: string): boolean {
	return open().prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0;
}

export function deleteJobs(ids: string[]): number {
	if (ids.length === 0) return 0;
	const placeholders = ids.map(() => "?").join(",");
	return open().prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids).changes;
}
