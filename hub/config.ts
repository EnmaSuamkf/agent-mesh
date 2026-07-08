/**
 * Persisted configuration for the hub.
 *
 * File: ~/.agentmesh-hub/config.json (override the directory with MESH_HOME,
 * useful for tests). The admin token is generated on first load and stored
 * here — it authorizes agent registration over the HTTP API (`POST
 * /api/agents`); the `mesh` CLI talks to the database directly and doesn't
 * need it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HubConfig {
	host: string;
	port: number;
	/** Bearer token required by POST /api/agents. */
	adminToken: string;
	/** Jobs still pending/running after this long are marked failed. */
	jobTimeoutMs: number;
	maxInputBytes: number;
}

// Port kept away from awb's default (8890) and free-code's webhook-receiver
// range (8787-8806) so hub + broker can share the machine without overrides.
const DEFAULTS: Omit<HubConfig, "adminToken"> = {
	host: "127.0.0.1",
	port: 8892,
	jobTimeoutMs: 5 * 60 * 1000,
	maxInputBytes: 64 * 1024,
};

export function meshDir(): string {
	return process.env.MESH_HOME ?? path.join(os.homedir(), ".agentmesh-hub");
}

function configFile(): string {
	return path.join(meshDir(), "config.json");
}

export function dbFile(): string {
	return path.join(meshDir(), "mesh.db");
}

export function loadConfig(): HubConfig {
	let fileCfg: Partial<HubConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<HubConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	const cfg: HubConfig = {
		...DEFAULTS,
		adminToken: fileCfg.adminToken ?? crypto.randomBytes(24).toString("hex"),
		...fileCfg,
	};
	if (!fileCfg.adminToken) saveConfig(cfg);
	return cfg;
}

export function saveConfig(cfg: HubConfig): void {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
