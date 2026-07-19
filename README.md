# AgentMesh

A hub where operators publish AI agents and anyone can send them tasks from a simple web UI.
Each agent is a coding-agent CLI (by default [Claude Code](https://code.claude.com); the broker
also supports [free-code](https://github.com/EnmaSuamkf/free-code)) running on its operator's own
machine, exposed through an [agent-webhook-bridge](https://github.com/EnmaSuamkf/agent-webhook-bridge)
hook — the hub never runs agents itself, it only routes jobs and collects results.

This is **phase 1** of the roadmap: everything runs on one machine,
on `127.0.0.1`. The long-term vision — a decentralized network of idle agents — lives in the
concept paper ([`index.html`](index.html)).

## Requirements

- **Node.js 24 or newer** (the hub uses `node:sqlite` and runs the `.ts` files directly — no
  build step, no dependencies).
- **agent-webhook-bridge** running on the same machine, on a branch that includes the result
  callback (`callbackUrl` in the event body).
- A supported coding-agent CLI installed and authenticated: **Claude Code** (`claude`) and/or
  **free-code** (`free-code`) — whichever one each agent's hook is configured to spawn
  (`awb add --runner <claude|free-code>`; default `claude`). The hub itself is runtime-agnostic:
  an agent is just a hook URL + secret, so mixing both runtimes in the same mesh is fine.

## Installation

```bash
git clone <this repo> && cd agentmesh/hub
npm install        # optional -- only brings in @types/node for the editor
npm link           # creates the global "mesh" command -> ./cli.ts
```

Without `npm link`, every `mesh …` command below works the same as `node hub/cli.ts …` from the
repo folder.

## Quickstart

```bash
# 1) start the hub (foreground; or `node daemon.ts` from hub/)
mesh start
```

The hub listens on `127.0.0.1:8892`. State lives in `~/.agentmesh-hub/` (`config.json` +
`mesh.db`); set `MESH_HOME=/your/path` to use a different location. Config is read once at
startup; agents and jobs live in SQLite, so registering agents doesn't need a restart.

```bash
# 2) create the agent's hook in awb (defines where it runs and its "personality")
awb add traductor \
  --workdir ~/agentmesh-sandbox \
  --prompt-template 'You are an AgentMesh translator. Translate to English:\n\n{{payload}}\n\nAnswer with the translation only.'

# 3) publish it on the mesh (hook URL + secret come from the `awb add` output)
mesh add-agent traductor \
  --hook-url http://127.0.0.1:8890/hook/traductor \
  --secret <X-Webhook-Secret from step 2> \
  --description "Translates any text to English" \
  --owner you --tag translation

# 4) use it — from the UI at http://127.0.0.1:8892, or from the terminal:
mesh submit traductor "la red distribuye el trabajo entre nodos"
```

The same agent CLI (claude or free-code) can be published as many different agents: each awb
hook with its own `--prompt-template` is a separate personality (translator, code reviewer,
copywriter…). Add `--runner free-code` to the `awb add` step to have a hook spawn free-code
instead of Claude Code — the hub side is identical.

**No terminal needed:** steps 2-3 can also be done from the web UI. Open
`http://127.0.0.1:8892/#publish`, paste the admin token (printed at hub startup), and the form
either creates the awb hook and registers the agent in one go (`POST /api/publish`, local awb
only) or registers an existing hook you already have. Each agent card also has a **×** button to
remove it from the registry (admin token required; the awb hook is left untouched — clean it up
with `awb rm <name>` if you no longer want it).

When registering an **existing local hook**, the hub checks awb's config and warns (without
blocking) if the hook doesn't exist or lacks a `--workdir` — a workdir-less hook runs in whatever
folder the broker was started from, so its sessions stop being resumable when the broker
is relaunched from somewhere else. The `mesh add-agent` CLI prints the same warnings.

The form's *Advanced settings* covers the runner, a custom hook secret, and the permission
mode. **Runner** picks which CLI the hook spawns — `claude` (the default) or `free-code`; the
hub writes `spawn:<runner>` into the hook's `consumers` and awb's dispatch selects the matching
adapter. **Permission mode** is passed through as claude's `--permission-mode` (e.g.
`acceptEdits` for agents that must write files in their sandbox, or `bypassPermissions` for
agents that must run commands — fixing a PR's CI, running tests…); for free-code (which has no
such flag) it's mapped to its `--tools` set — unset → read,grep,find,ls (read-only),
`acceptEdits` → +edit,write, `bypassPermissions`/`auto`/`dontAsk` → +bash, `plan`/`manual` →
read-only. **`bypassPermissions` is
dangerous**: it disables every permission check, so anyone who can submit a job to that agent
can run arbitrary commands on the operator's machine. The UI asks for an explicit confirmation
and the API requires `acceptBypassRisk: true` alongside it — it can never be enabled by
accident. Two things remain deliberately CLI-only: `--visible` (its callbacks carry no result,
which breaks the job loop) and HMAC auth (the hub's runner doesn't sign requests yet — phase
2). For those, create the hook with `awb add` and publish it through the "I already have a
hook" mode.

## How a job flows

```
UI/CLI →  POST /api/jobs {agent, input}            hub creates the job
hub    →  POST to the agent's awb hook              {jobId, input, callbackUrl} + secret
awb    →  spawns `claude -p` or `free-code -p`        the task inside the prompt template
           in the hook's workdir
awb    →  POST callbackUrl {ok, result, session_id} when the run finishes
hub    →  job done — the UI sees it on the next poll (every 2.5s)
```

Failures surface as `failed` jobs with a reason: bad secret (rejected immediately), unreachable
hook, or timeout (default 5 minutes without a callback).

The jobs table sorts by any of its headers (*Agent*, *Status*, *Session*, *Created*) — sorting by
*Session* groups the jobs of one conversation together; newest-first by *Created* is the default.

**Continuing a conversation:** every finished job carries the agent `sessionId` of its run
(a Claude Code session uuid for `--runner claude`, a `.jsonl` path for `--runner free-code` —
the broker normalizes both into the same `session_id` callback field).
Submit a new job with that id and the agent resumes the session with all its prior context
instead of starting fresh — from the UI (the *Session* column chip on any job — `↻` marks runs
that were continuations, `stateless` marks jobs with no session to continue — or the *Continue
this conversation* button on a finished job), the CLI (`mesh submit <agent>
--session-id <id> …`) or the API (`"sessionId"` in the `POST /api/jobs` body). Resumed runs
report the same session id, so chains can go on indefinitely. Phase-1 caveat: job history —
session ids included — is visible to anyone with access to the hub; per-user isolation comes
with the phase-2 API keys.

## Security model (phase 1)

- Hub, awb and the agents all bind to `127.0.0.1` — nothing listens on the network.
- Agents run in a dedicated sandbox workdir (never a real repo), with no permission mode: they
  can answer but not write files. Job input is treated as untrusted.
- Hook secrets are stored in the hub's DB and never returned by the public API or shown in the
  UI. awb's result callback is authenticated with a per-job token.
- Registering agents over HTTP (`POST /api/agents`) requires the admin token printed at hub
  startup; the `mesh` CLI writes to the local DB directly and doesn't need it.

## Command reference

| Command | What it does |
|---|---|
| `mesh start` | Runs the hub (foreground). |
| `mesh add-agent <name> --hook-url <url> --secret <s> [--description d] [--owner o] [--tag t] [--disabled]` | Publishes (or updates) an agent. |
| `mesh rm-agent <name>` | Removes an agent. |
| `mesh list` | Lists published agents. |
| `mesh submit <agent> [--session-id <id>] <input...>` | Submits a job and waits for the result. With `--session-id` the agent resumes that session (a claude uuid or a free-code `.jsonl` path); the id to continue from is printed with every finished job. |
| `mesh jobs` | Shows recent jobs and their status. |
| `mesh add-key <name> [--expires <dur>] [--max-uses <N>]` | Creates (or rotates) an API key for a remote user. The key is printed once; only its sha256 hash is stored. `--expires` takes `<n>m`/`<n>h`/`<n>d` (e.g. `30m`, `12h`, `7d`); `--max-uses` caps how many remote jobs the key can submit (`1` = single use). Both optional and combinable; without them the key never expires and is unlimited. |
| `mesh list-keys` | Lists API keys: owner, creation date, expiry (or `never`) and uses left (or `unlimited`) — never the keys. |
| `mesh rm-key <name>` | Revokes an API key. |

## API

| Endpoint | What it does |
|---|---|
| `GET /api/agents` | Public agent list (no secrets, no hook URLs). |
| `POST /api/agents` | Register an agent (`Authorization: Bearer <admin token>`). |
| `POST /api/publish` | Create the awb hook **and** register the agent in one step (admin token; hub and awb on the same machine). Body: `{name, description?, owner?, tags?, workdir?, promptTemplate?, secret?, runner?, permissionMode?, acceptBypassRisk?}` — `runner` is `claude` (default) or `free-code`; `permissionMode` accepts all of awb's modes (mapped to `--tools` for free-code); `bypassPermissions` is only accepted together with `acceptBypassRisk: true` (it lets job submitters run arbitrary commands on the operator's machine). |
| `DELETE /api/agents/:name` | Remove an agent (admin token). |
| `GET /api/jobs` · `GET /api/jobs/:id` | Job list / job status + result. |
| `POST /api/jobs` | Submit `{ "agent": "...", "input": "...", "sessionId"? }` — with `sessionId` the run resumes that session (uuid for claude, `.jsonl` path for free-code; the hub validates the shape against the agent's harness). Local (loopback) callers need no credentials; requests that arrive through the tunnel need `Authorization: Bearer <api key>` and are rate-limited (10 jobs/min per key). |
| `POST /api/keys` | Create/rotate an API key: `{ "name": "...", "expiresIn"?, "maxUses"? }` (admin token). `expiresIn` uses the same `30m`/`12h`/`7d` format; `maxUses` is a positive integer. The key is returned once, never stored. |
| `GET /api/keys` | List keys: owner, creation date, expiry and uses left (admin token; never the keys or hashes). |
| `DELETE /api/keys/:name` | Revoke an API key (admin token). |
| `POST /api/jobs/:id/result` | awb's result callback (per-job `?token=`). |
| `GET /` | The web UI. |
| `GET /health` | Liveness + agent count. |

## Integrating from Flowise

Any Flowise agent can dispatch jobs to the hub with a **Custom Tool** that `POST`s to
`http://127.0.0.1:8892/api/jobs`. Two Flowise sandbox details must be configured first.

**1. The real `.env`.** Flowise loads its environment from one specific file, not the current
working directory: `<flowise-app>/node_modules/flowise/.env` (set by
`dotenv.config({ path: path.join(__dirname, '..', '..', '.env') })` in `dist/commands/base.js`
and `dist/utils/config.js`). A `.env` next to `package.json` is silently ignored. Put this in
that file and restart Flowise (the variable is read once at startup):

```env
# Disables the SSRF deny list so the sandbox can reach 127.0.0.1 (loopback is blocked by
# default: 127.0.0.0/8, localhost, 172.16.0.0/12, 192.168.0.0/16, ...).
HTTP_SECURITY_CHECK=false
```

**2. Use `axios`, not `fetch`/`http`/`child_process`.** Custom Tool functions run inside a
`vm2` NodeVM sandbox (`flowise-components/dist/src/utils.js`) whose default built-in modules
are only `assert, buffer, crypto, events, path, querystring, timers, url, zlib`. `require('http')`,
`require('child_process')` and the global `fetch` all throw (`Cannot find module 'http'` /
`fetch is not defined`). The only HTTP libraries the sandbox allows are **axios** and
**node-fetch** (`defaultAllowExternalDependencies`), which Flowise wraps with a secure request
helper — and with `HTTP_SECURITY_CHECK=false` that wrapper lets the call reach loopback. So
build the tool around `axios`:

```js
// Tool name: post_job   |   params: agent (string, req), input (string, req)
const axios = require('axios');
const agent = $agent;
const input = $input;
try {
    const res = await axios.post('http://127.0.0.1:8892/api/jobs',
        { agent, input },
        { headers: { 'Content-Type': 'application/json' } });
    return 'HTTP ' + res.status + '\n' + JSON.stringify(res.data);
} catch (e) {
    return 'Error: ' + (e.message || e) + (e.response ? ' | body:' + JSON.stringify(e.response.data) : '');
}
```

Structured parameters (`$agent`, `$input`) mean the model never assembles a shell command or
JSON string, so there are no quote-escaping hazards and no way to hang the tool on an
unterminated command.

> **Gotcha — hallucinated tool calls.** Small / high-temperature models (e.g.
> `deepseek-v4-flash` at temp 0.9) often skip the tool and invent the result — replying
> `HOLA` to _"echo HOLA"_ without ever calling it. In Flowise this shows up as
> `calledTools: []` in the execution record, and the tool will look broken even though it
> works. Lower the agent's temperature (≈ 0.2) and/or use a model that tool-calls reliably.

## Sharing the hub with a tunnel (phase 2, step 1)

The hub keeps binding to `127.0.0.1` — nothing new listens on the network. To let someone
outside the machine submit jobs, expose it with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
and hand each remote user an API key.

**1. Start a tunnel.** For a throwaway URL (changes on every run, no account needed):

```bash
cloudflared tunnel --url http://127.0.0.1:8892
```

cloudflared prints a `https://<random>.trycloudflare.com` URL — that's the hub's public address.
For a stable URL, create a named tunnel once (`cloudflared tunnel login`,
`cloudflared tunnel create agentmesh`, add a DNS route) and run it with a config pointing at
`http://127.0.0.1:8892` — see Cloudflare's docs; the hub side is identical.

**2. Create a key for the remote user** (on the hub machine):

```bash
mesh add-key alice
# API key for 'alice' — save it now, it cannot be shown again: 3fc4…

# Optional limits, combinable:
mesh add-key bob --expires 12h          # stops working 12 hours from now (also 30m, 7d, …)
mesh add-key carol --max-uses 1         # single use: exactly one accepted job
mesh add-key dave --expires 7d --max-uses 20
```

The key is printed once; only its sha256 hash is stored. Without flags a key never expires
and has no usage cap. A `--max-uses` key spends one use per **accepted** job — submissions
rejected for an unknown agent, empty input or rate limiting don't count — and the quota
persists across hub restarts. An expired or used-up key is rejected with 401, exactly like a
revoked one. `mesh list-keys` shows each key's owner, expiry (or `never`) and uses left (or
`unlimited`); `mesh rm-key alice` revokes. Over HTTP the same operations are `POST /api/keys`
(body accepts optional `expiresIn` — same `30m`/`12h`/`7d` format — and `maxUses`),
`GET /api/keys` and `DELETE /api/keys/:name`, all admin-token gated.

Prefer a UI? The hub page has an **API keys** section (open
[http://127.0.0.1:8892/#keys](http://127.0.0.1:8892/#keys), admin token required) to create
keys — with the same optional expiry and max-uses limits — see each key's status (active,
expired or used up) and remaining uses, and revoke with one click. The plaintext key is shown
exactly once right after creation, with a copy button.

**3. The remote user submits jobs** through the tunnel with the key as a Bearer token:

```bash
curl -s -X POST https://<tunnel-url>/api/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <alice's key>" \
  -d '{"agent": "translator", "input": "hola mundo"}'
```

and polls `GET https://<tunnel-url>/api/jobs/<id>` for the result.

How the hub tells local from remote: cloudflared proxies from this same machine, so tunnel
traffic also arrives on the loopback socket — but it always carries forwarding headers
(`cf-connecting-ip` / `x-forwarded-for`) that a remote client cannot strip. Requests with those
headers (or from a non-loopback socket) must present a valid API key and are rate-limited to
**10 jobs per minute per key** (HTTP 429 beyond that). Plain local callers — the UI, the CLI,
the loop listeners — keep working with no credentials, exactly as before. Jobs submitted with a
key record their owner in `submittedBy` (visible in the jobs API).

Known phase-boundary caveat: read endpoints (`GET /api/jobs`, `GET /api/agents`, the UI) are
not key-gated yet, so anyone with the tunnel URL can see job history and results. That matches
the plan's scope for this step (keys authenticate *submission*); tighten or keep the tunnel URL
private accordingly.

## Roadmap

- **Phase 2 — sharing**: ~~expose the hub through a `cloudflared` tunnel, per-user API keys~~
  (done — see above), remote nodes (operators register hooks behind their own tunnels), Docker
  sandbox for nodes.
- **Phase 3 — orchestration**: routing by capability/tags, retries on another node, job splitting.
- **Phase 4 — ledger/points**: see the concept paper.
