#!/usr/bin/env node
/**
 * Fast awb sync for `npm start`: clone when missing, else `git pull --ff-only`.
 * Same logic as scripts/install.ts `syncAwb`, without dependency installs.
 * Pull failure is warn-only so an offline machine can still start.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AWB_REPO_URL = "https://github.com/EnmaSuamkf/agent-webhook-bridge.git";

function awbDir() {
	return process.env.AWB_DIR ?? path.join(REPO_DIR, "agent-webhook-bridge");
}

function log(message, type = "info") {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function run(cmd, args, cwd) {
	const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (res.error) {
		log(`could not run \`${cmd}\`: ${res.error.message}`, "error");
		process.exit(1);
	}
	return res.status ?? 1;
}

function runQuiet(cmd, args, cwd) {
	const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (res.error) {
		log(`could not run \`${cmd}\`: ${res.error.message}`, "error");
		process.exit(1);
	}
	return { status: res.status ?? 1, stdout: res.stdout ?? "" };
}

function requireGit() {
	if (runQuiet("git", ["--version"], REPO_DIR).status !== 0) {
		log("`git` is required to sync agent-webhook-bridge but isn't on PATH.", "error");
		process.exit(1);
	}
}

function syncAwb(dir) {
	if (!fs.existsSync(dir)) {
		log(`agent-webhook-bridge: cloning into ${dir}...`);
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		if (run("git", ["clone", AWB_REPO_URL, dir], REPO_DIR) !== 0) {
			log(`could not clone ${AWB_REPO_URL} into ${dir}`, "error");
			process.exit(1);
		}
		return;
	}
	if (!fs.existsSync(path.join(dir, ".git"))) {
		log(`${dir} exists but is not a git clone. Remove it, or point AWB_DIR at a real agent-webhook-bridge clone.`, "error");
		process.exit(1);
	}
	log(`agent-webhook-bridge: updating existing clone at ${dir}...`);
	if (runQuiet("git", ["pull", "--ff-only"], dir).status !== 0) {
		log("agent-webhook-bridge: could not fast-forward the clone — keeping it as is.", "warning");
	}
}

requireGit();
syncAwb(awbDir());
