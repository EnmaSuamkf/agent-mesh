# AgentMesh

A hub where operators publish AI agents and anyone can send them tasks from a simple web UI.
Each agent is a [Claude Code](https://code.claude.com) instance running on its operator's own
machine, exposed through an [agent-webhook-bridge](https://github.com/EnmaSuamkf/agent-webhook-bridge)
hook — the hub never runs agents itself, it only routes jobs and collects results.

This is **phase 1** of the roadmap (see [`PLAN.md`](PLAN.md)): everything runs on one machine,
on `127.0.0.1`. The long-term vision — a decentralized network of idle agents — lives in the
concept paper ([`index.html`](index.html)).

## Requirements

- **Node.js 24 or newer** (the hub uses `node:sqlite` and runs the `.ts` files directly — no
  build step, no dependencies).
- **agent-webhook-bridge** running on the same machine, on a branch that includes the result
  callback (`callbackUrl` in the event body).
- **Claude Code CLI** installed and authenticated (it's what awb spawns to run each job).

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

The same Claude can be published as many different agents: each awb hook with its own
`--prompt-template` is a separate personality (translator, code reviewer, copywriter…).

**No terminal needed:** steps 2-3 can also be done from the web UI. Open
`http://127.0.0.1:8892/#publicar`, paste the admin token (printed at hub startup), and the form
either creates the awb hook and registers the agent in one go (`POST /api/publish`, local awb
only) or registers an existing hook you already have.

## How a job flows

```
UI/CLI →  POST /api/jobs {agent, input}            hub creates the job
hub    →  POST to the agent's awb hook              {jobId, input, callbackUrl} + secret
awb    →  spawns `claude -p` in the hook's workdir  the task inside the prompt template
awb    →  POST callbackUrl {ok, result, session_id} when the run finishes
hub    →  job done — the UI sees it on the next poll (every 2.5s)
```

Failures surface as `failed` jobs with a reason: bad secret (rejected immediately), unreachable
hook, or timeout (default 5 minutes without a callback).

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
| `mesh submit <agent> <input...>` | Submits a job and waits for the result. |
| `mesh jobs` | Shows recent jobs and their status. |

## API

| Endpoint | What it does |
|---|---|
| `GET /api/agents` | Public agent list (no secrets, no hook URLs). |
| `POST /api/agents` | Register an agent (`Authorization: Bearer <admin token>`). |
| `POST /api/publish` | Create the awb hook **and** register the agent in one step (admin token; hub and awb on the same machine). |
| `DELETE /api/agents/:name` | Remove an agent (admin token). |
| `GET /api/jobs` · `GET /api/jobs/:id` | Job list / job status + result. |
| `POST /api/jobs` | Submit `{ "agent": "...", "input": "..." }`. |
| `POST /api/jobs/:id/result` | awb's result callback (per-job `?token=`). |
| `GET /` | The web UI. |

## Roadmap

- **Phase 2 — sharing**: expose the hub through a `cloudflared` tunnel, per-user API keys,
  remote nodes (operators register hooks behind their own tunnels), Docker sandbox for nodes.
- **Phase 3 — orchestration**: routing by capability/tags, retries on another node, job splitting.
- **Phase 4 — ledger/points**: see the concept paper.
