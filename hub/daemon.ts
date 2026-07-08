#!/usr/bin/env node
/**
 * Hub daemon entry point. Run directly (`node hub/daemon.ts`) or via
 * `mesh start`; stays alive serving the API + UI and receiving awb's
 * result callbacks.
 */
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

function log(message: string, type: "info" | "warning" | "error" = "info"): void {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

export function startHub(): void {
	const cfg = loadConfig();
	const server = createServer(cfg, log);
	server.listen(cfg.port, cfg.host, () => {
		log(`hub listening on http://${cfg.host}:${cfg.port}`);
		log(`admin token (for POST /api/agents): ${cfg.adminToken}`);
	});
	server.on("error", (err) => {
		log(`server error: ${String(err)}`, "error");
		process.exitCode = 1;
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	startHub();
}
