# AgentMesh — Implementation plan

Date: 2026-07-08
Status: **phase 1 implemented** (shipped 2026-07-08; kept as the original implementation plan)

> Goal of this stage: go from the concept paper (`index.html`, phase 0) to a **real phase 1**:
> something simple, secure, with at least **one complete task loop** (submit task → agent runs
> it → result visible), and a **simple but functional interface** where agents are published so
> others can use them. Multi-node orchestration and ledger/payments stay for later, exactly as
> the paper says.
>
> Decided scope: **agent-webhook-bridge + Claude Code only**. Flowise is out of the project.

---

## 1. What we already have (and reuse as-is)

| Piece | State | Role in AgentMesh |
|---|---|---|
| **agent-webhook-bridge (awb)** | Working (broker + `claude -p`/`--resume` spawn, secrets/HMAC, SQLite, per-workdir serialization) | It's the paper's "bridge": the way to expose a local Claude Code agent as an HTTP endpoint. **Nothing gets rewritten**; it only gains a result callback (see §4.2). |
| **agentmesh/index.html** | Concept paper | The vision. This plan implements its "Phase 1 — single-operator bridge". |

Technical fact that shapes the design (verified in awb's `broker/dispatch.ts` and `server.ts`):
`POST /hook/:name` answers `{ok:true}` immediately and the Claude spawn runs in the background;
the result only lands in `~/.agent-webhook-bridge/logs/` and in SQLite's delivery state. **A job
is asynchronous by nature** → the loop closes with an HTTP callback when the run finishes (§4.2).

## 2. Phase-1 architecture

```
                       ┌────────────────────────────────────┐
   user/requester      │  agentmesh-hub  (new, ~600 loc)    │
   (browser or curl)   │                                    │
        │              │  simple HTML UI  +  REST API       │
        ├── see agents │  ┌──────────────────────────────┐  │
        ├── submit job │  │ agent registry (SQLite)      │  │
        └── see result │  │ job queue      (SQLite)      │  │
                       │  └──────────────┬───────────────┘  │
                       └─────────────────┼──────────────────┘
                                         │
                                         │ POST /hook/<name>
                                         │ body: { jobId, input, callbackUrl }
                                         ▼
                              awb broker ──▶ spawn claude -p (sandbox workdir)
                                                    │
                                                    │ when done:
                                                    ▼
                                        POST {callbackUrl}
                                        (new callback in awb)
                                                    │
                       job "done" with result ◀────┘
                       (the UI sees it by polling)
```

- **agentmesh-hub**: new project in `agentmesh/hub/`. Same stack as awb to add zero
  dependencies: **Node 24, TypeScript executed directly, `node:sqlite`, zero build, zero
  framework**. One process serving both the API and the UI.
- **Agent** = a registry row: `{ id, name, description, hookUrl, secret, owner, tags,
  enabled }` — every agent is an awb hook (local now, remote via tunnel in phase 2). Secrets
  are stored in the hub and **never** shown in the UI or the public API.
- **Job** = `{ id, agentId, input, status: pending|running|done|failed, result, created_at,
  finished_at }`.

## 3. The complete task loop (phase-1 success criterion)

1. In the UI I pick the "claude-worker" agent and type the task (e.g. *"analyze this text and
   produce a markdown report"*).
2. The hub creates the job (`pending`) and POSTs to `http://127.0.0.1:8890/hook/agentmesh-worker`
   with the hook's secret, body `{ jobId, input, callbackUrl }` → job `running`.
3. awb spawns `claude -p` in the **sandbox workdir** (see §5) with a prompt template that frames
   the task and asks for the final result as the turn's answer.
4. When the process finishes, awb's spawn-runner POSTs `{callbackUrl}` with the `result` from
   Claude's JSON → the hub marks the job `done` (or `failed` on non-zero exit / timeout).
5. The UI (polling `GET /jobs/:id` every 2s) shows the result.

When this loop works end to end from the browser, phase 1 is done.

## 4. Work to do

### 4.1 `agentmesh/hub/` (new)

```
agentmesh/
├── index.html          (concept paper, untouched)
├── PLAN.md             (this document)
└── hub/
    ├── server.ts       HTTP: API + UI statics
    ├── db.ts           SQLite: agents + jobs
    ├── runner.ts       dispatch to the awb hook + timeout + callback token
    ├── cli.ts          `mesh add-agent`, `mesh list`, `mesh submit` (testing without the UI)
    └── ui/index.html   the interface (vanilla, same aesthetic as the paper)
```

**Minimal API:**

| Endpoint | What it does |
|---|---|
| `GET /api/agents` | Public agent list (no secrets). |
| `POST /api/agents` | Registers an agent (requires the hub's admin token). |
| `POST /api/jobs` | `{ agentId, input }` → creates the job and dispatches it to the agent's hook. |
| `GET /api/jobs/:id` | Status + result (the UI polls this). |
| `POST /api/jobs/:id/result` | Callback used by awb; authenticated with a per-job token. |
| `GET /` | The UI. |

**UI (one page, no framework):** three blocks — *Available agents* (cards with name,
description, owner, status), *Send a task* (agent select + textarea + button), *Jobs* (table
with live status and expandable result). Reuse the concept paper's CSS variables so it reads as
the same family.

### 4.2 Minimal change in awb: result callback

The only change outside the hub (~25 lines):

- If the incoming event's JSON carries a `callbackUrl`, the spawn-runner uses it when the run
  finishes. **Decision: read it from the body, not as a hook option** — one hook then serves any
  hub/caller and awb stays decoupled from AgentMesh.
- In `adapters/spawn-runner/claude.ts`, on finish: `POST callbackUrl` with
  `{ ok, result, session_id, exitCode }` (the `result` is already in the JSON that
  `--output-format json` returns). One simple retry, and nothing breaks if the callback fails
  (the log remains the source of truth).
- Security restriction: only accept `callbackUrl` pointing at `127.0.0.1` while we're in the
  local phase (prevents a caller from using awb as a proxy against other URLs).

### 4.3 Registering the demo agent

```bash
# 1. dedicated awb hook, sandbox workdir
awb add agentmesh-worker --trigger \
  --workdir ~/agentmesh-sandbox \
  --prompt-template 'You are an AgentMesh agent. Incoming task:\n\n{{payload}}\n\nDo the task and answer with the final result.'

# 2. register it in the hub
mesh add-agent claude-worker \
  --hook-url http://127.0.0.1:8890/hook/agentmesh-worker \
  --secret <the one awb add returned> \
  --description "General-purpose Claude Code agent (analysis, writing, code)"
```

## 5. Phase-1 security (simple but real)

1. **Everything on 127.0.0.1**: hub and awb. Nothing listens on the network in this phase.
2. **Dedicated sandbox workdir** (`~/agentmesh-sandbox`): the AgentMesh hook **never** points at
   a real repo. No `--permission-mode` at first (Claude answers but doesn't write); if a use
   case needs file writes, `acceptEdits` **only** inside that sandbox.
3. **Job input is untrusted input** (the paper's premise): the prompt template frames it as a
   task, and the sandbox + no permissions bound the damage of a hostile prompt. Full Docker
   containment is phase 2.
4. **Secrets**: each hook's secret lives only in the hub's DB; the public API never returns it.
   Callback authenticated with an ephemeral per-job token. `callbackUrl` restricted to localhost
   in this phase.
5. **Limits**: per-job timeout (e.g. 5 min → `failed`), max input size, and awb's existing
   per-workdir serialization prevents concurrent spawns.

## 6. Phase 2 — Sharing agents with others (after the loop)

In order, each step shippable on its own:

1. **Tunnel**: expose the hub with `cloudflared tunnel` (free HTTPS, no open ports). The UI
   already exists, only the URL changes. Per-user API keys for `POST /api/jobs` (so submitting
   isn't anonymous) and basic rate limiting.
2. **Remote nodes**: another operator runs awb + a tunnel on their machine and registers their
   agent in your hub with their hook's public URL (and the localhost `callbackUrl` restriction
   is lifted: it becomes the hub's public URL). The hub becomes the paper's "minimal
   orchestrator": the registry already knows which node is behind each agent. Health checks
   (periodic ping) to mark agents online/offline in the UI.
3. **Docker sandbox**: package the node (awb + authenticated claude + sandbox) into a container,
   delivering the paper's isolation promise.

## 7. Phases 3-4 (unchanged from the paper)

- **Phase 3 — orchestration**: routing by capability/tags, retry on another node, job splitting.
- **Phase 4 — ledger/points**: only once there's more than one real operator.

## 8. Suggested execution order (phase 1)

| # | Deliverable | Verification |
|---|---|---|
| 1 | Callback in awb (§4.2) | `curl` to the hook with a `callbackUrl` pointing at a test server → the run's result arrives |
| 2 | Hub: DB + API + runner + CLI | `mesh submit` closes the full loop from the terminal |
| 3 | UI served by the hub | Full loop from the browser |
| 4 | Timeouts, per-job token, UI polish | An expired job ends `failed`; secrets never visible |

Honest estimate: the hub is about the size of awb's broker (~600 lines); steps 1-2 are a calm
day of work, 3-4 one more.

## 9. Default decisions taken (say so if you want otherwise)

- **No Flowise**: the project uses awb + Claude Code exclusively as the agent type. If another
  runtime ever joins, the registry already supports it (it's just another `hookUrl`).
- **Hub stack**: Node 24 + `node:sqlite` + direct TS, same as awb (zero friction, zero build).
- **Callback in the event body**, not as a hook option (§4.2), to keep awb decoupled from the hub.
- **Sharing = phase 2 with a tunnel**; phase 1 is 100% local to validate the loop without
  exposing anything.
- **Vanilla UI** (no React/framework): one page, the concept paper's aesthetic.
