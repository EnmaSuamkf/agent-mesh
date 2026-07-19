#!/usr/bin/env node
// Starts a service via `npm start --prefix <dir>`, but first checks whether
// something is already listening on its port — awb in particular is meant
// to be a persistent background service other tools may already be running,
// so finding it up is success, not a conflict to fail on.
//
// Usage: node start-service.js <name> <dir> <port>
import { spawn } from "node:child_process";
import * as net from "node:net";

const [name, dir, portArg] = process.argv.slice(2);
if (!name || !dir || !portArg) {
	console.error("usage: node start-service.js <name> <dir> <port>");
	process.exit(1);
}
const port = Number(portArg);

function isAlreadyRunning(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (result) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

const already = await isAlreadyRunning("127.0.0.1", port, 800);
if (already) {
	console.log(`[${name}] already running on port ${port}, skipping start`);
	process.exit(0);
}

// detached so the child (and whatever it forks, e.g. npm forking
// `node daemon.ts`) gets its own process group — that lets us signal the
// whole group below instead of just the immediate npm process, which some
// npm versions don't reliably forward SIGINT/SIGTERM to.
const child = spawn("npm", ["start", "--prefix", dir], {
	stdio: "inherit",
	detached: true,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		if (child.pid) process.kill(-child.pid, sig);
	});
}

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 0);
	}
});
