#!/usr/bin/env node
/** Fail fast with a clear message when Node is too old for AgentMesh. */
const major = Number(process.versions.node.split(".")[0]);
const MIN = 24;
if (major < MIN) {
	console.error(
		`AgentMesh requires Node.js ${MIN}+ (you have ${process.versions.node}).\n` +
			`The hub runs TypeScript directly (\`node daemon.ts\`) — that needs Node ${MIN}+.\n` +
			`Install Node ${MIN} (e.g. \`nvm install\` in this repo — .nvmrc is set to ${MIN}) and retry.`,
	);
	process.exit(1);
}
