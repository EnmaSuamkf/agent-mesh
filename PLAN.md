# AgentMesh — Plan de implementación

Fecha: 2026-07-08
Estado: **plan aprobable, sin implementar**

> Objetivo de esta etapa: pasar del concept paper (`index.html`, fase 0) a la **fase 1 real**:
> algo simple, seguro, con **un loop completo de tarea** (enviar tarea → agente la ejecuta →
> resultado visible), y una **interfaz simple pero funcional** donde publicar agentes para que
> otros los usen. Las fases de orquestación multi-nodo y ledger/pagos quedan para después, igual
> que dice el paper.
>
> Alcance decidido: **solo agent-webhook-bridge + Claude Code**. Flowise queda fuera del proyecto.

---

## 1. Qué ya tenemos (y qué reusamos tal cual)

| Pieza | Estado | Rol en AgentMesh |
|---|---|---|
| **agent-webhook-bridge (awb)** | Funcionando (broker + spawn `claude -p`/`--resume`, secretos/HMAC, SQLite, serialización por workdir) | Es el "bridge" del paper: la forma de exponer un agente Claude Code local como endpoint HTTP. **No se reescribe nada**; solo se le agrega un callback de resultado (ver §4.2). |
| **agentmesh/index.html** | Concept paper | La visión. Este plan implementa su "Phase 1 — single-operator bridge". |

Dato técnico que condiciona el diseño (verificado en `broker/dispatch.ts` y `server.ts` de awb):
el `POST /hook/:name` responde `{ok:true}` al instante y el spawn de Claude corre en background;
el resultado solo queda en `~/.agent-webhook-bridge/logs/` y en el estado de SQLite. **Un job es
asíncrono por naturaleza** → el loop se cierra con un callback HTTP al terminar el run (§4.2).

## 2. Arquitectura de la fase 1

```
                       ┌────────────────────────────────────┐
   usuario/requester   │  agentmesh-hub  (nuevo, ~600 loc)  │
   (browser o curl)    │                                    │
        │              │  UI HTML simple  +  API REST       │
        ├── ver agentes│  ┌──────────────────────────────┐  │
        ├── enviar job │  │ registry de agentes (SQLite) │  │
        └── ver result │  │ cola de jobs      (SQLite)   │  │
                       │  └──────────────┬───────────────┘  │
                       └─────────────────┼──────────────────┘
                                         │
                                         │ POST /hook/<name>
                                         │ body: { jobId, input, callbackUrl }
                                         ▼
                              broker awb ──▶ spawn claude -p (workdir sandbox)
                                                    │
                                                    │ al terminar:
                                                    ▼
                                        POST {callbackUrl}
                                        (callback nuevo en awb)
                                                    │
                       job "done" con resultado ◀───┘
                       (la UI lo ve por polling)
```

- **agentmesh-hub**: proyecto nuevo en `agentmesh/hub/`. Mismo stack que awb para no sumar
  dependencias: **Node 24, TypeScript ejecutado directo, `node:sqlite`, cero build, cero
  framework**. Un solo proceso que sirve la API y la UI.
- **Agente** = una fila del registry: `{ id, name, description, hookUrl, secret, owner, tags,
  enabled }` — cada agente es un hook de awb (local ahora, remoto vía túnel en fase 2). Los
  secretos se guardan en el hub y **nunca** se muestran en la UI ni en la API pública.
- **Job** = `{ id, agentId, input, status: pending|running|done|failed, result, created_at,
  finished_at }`.

## 3. El loop completo de tarea (criterio de éxito de la fase 1)

1. En la UI elijo el agente "claude-worker" y escribo la tarea (ej.: *"analizá este texto y
   generá un informe en markdown"*).
2. Hub crea el job (`pending`) y hace `POST http://127.0.0.1:8890/hook/agentmesh-worker` con el
   secret del hook, body `{ jobId, input, callbackUrl }` → job `running`.
3. awb spawnea `claude -p` en el **workdir sandbox** (ver §5) con un prompt-template que enmarca
   la tarea y pide terminar el turno con el resultado final.
4. Al terminar el proceso, el spawn-runner de awb hace `POST {callbackUrl}` con el `result` del
   JSON de Claude → hub marca el job `done` (o `failed` si exit ≠ 0 / timeout).
5. La UI (polling cada 2s sobre `GET /jobs/:id`) muestra el resultado.

Cuando este loop funciona de punta a punta desde el browser, la fase 1 está cumplida.

## 4. Trabajo a realizar

### 4.1 `agentmesh/hub/` (nuevo)

```
agentmesh/
├── index.html          (concept paper, no se toca)
├── PLAN.md             (este documento)
└── hub/
    ├── server.ts       HTTP: API + estáticos de la UI
    ├── db.ts           SQLite: agents + jobs
    ├── runner.ts       despacho al hook de awb + timeout + token de callback
    ├── cli.ts          `mesh add-agent`, `mesh list`, `mesh submit` (para probar sin UI)
    └── ui/index.html   la interfaz (vanilla, misma estética del paper)
```

**API mínima:**

| Endpoint | Qué hace |
|---|---|
| `GET /api/agents` | Lista pública de agentes (sin secretos). |
| `POST /api/agents` | Registra un agente (requiere admin token del hub). |
| `POST /api/jobs` | `{ agentId, input }` → crea el job y lo despacha al hook del agente. |
| `GET /api/jobs/:id` | Estado + resultado (la UI hace polling de esto). |
| `POST /api/jobs/:id/result` | Callback que usa awb; autenticado con un token por job. |
| `GET /` | La UI. |

**UI (una sola página, sin framework):** tres bloques — *Agentes disponibles* (cards con nombre,
descripción, owner, estado), *Enviar tarea* (select de agente + textarea + botón), *Mis jobs*
(tabla con estado en vivo y resultado expandible). Reusar las variables CSS del concept paper
para que se vea de la misma familia.

### 4.2 Cambio mínimo en awb: callback de resultado

Único cambio fuera del hub (~25 líneas):

- Si el JSON del evento entrante trae `callbackUrl`, el spawn-runner la usa al terminar el run.
  **Decisión: leerla del body y no como opción del hook** — así un mismo hook sirve para
  cualquier hub/caller y awb no queda acoplado a AgentMesh.
- En `adapters/spawn-runner/claude.ts`, al terminar: `POST callbackUrl` con
  `{ ok, result, session_id, exitCode }` (el `result` ya está en el JSON que devuelve
  `--output-format json`). Con un retry simple y sin romper nada si el callback falla
  (el log sigue siendo la fuente de verdad).
- Restricción de seguridad: solo aceptar `callbackUrl` hacia `127.0.0.1` mientras estemos en
  fase local (evita que un caller use a awb como proxy para pegarle a otras URLs).

### 4.3 Registro del agente de demo

```bash
# 1. hook de awb dedicado, con workdir sandbox
awb add agentmesh-worker --trigger \
  --workdir ~/agentmesh-sandbox \
  --prompt-template 'Sos un agente de AgentMesh. Tarea recibida:\n\n{{payload}}\n\nRealizá la tarea y respondé con el resultado final.'

# 2. registrarlo en el hub
mesh add-agent claude-worker \
  --hook-url http://127.0.0.1:8890/hook/agentmesh-worker \
  --secret <el que devolvió awb add> \
  --description "Agente Claude Code de propósito general (análisis, redacción, código)"
```

## 5. Seguridad de la fase 1 (simple pero de verdad)

1. **Todo en 127.0.0.1**: hub y awb. Nada escucha en la red en esta fase.
2. **Workdir sandbox dedicado** (`~/agentmesh-sandbox`): el hook de AgentMesh **nunca** apunta a
   un repo real. Sin `--permission-mode` al principio (Claude responde pero no escribe); si un
   caso de uso necesita escribir archivos, `acceptEdits` **solo** en ese sandbox.
3. **El input del job es input no confiable** (es la premisa del paper): el prompt-template lo
   enmarca como tarea, y el sandbox + sin permisos limita el daño de un prompt hostil. La
   contención Docker completa es fase 2.
4. **Secretos**: el secret de cada hook vive solo en la DB del hub; la API pública jamás lo
   devuelve. Callback autenticado con token efímero por job. `callbackUrl` restringida a
   localhost en esta fase.
5. **Límites**: timeout por job (ej. 5 min → `failed`), tamaño máximo de input, y la
   serialización por workdir que awb ya tiene evita spawns concurrentes.

## 6. Fase 2 — Compartir agentes con otros (después del loop)

En orden, cada paso publicable por separado:

1. **Túnel**: exponer el hub con `cloudflared tunnel` (HTTPS gratis, sin abrir puertos). La UI ya
   existe, solo cambia la URL. API keys de usuario para `POST /api/jobs` (que enviar tareas no
   sea anónimo) y rate-limit básico.
2. **Nodos remotos**: otro operador corre awb + túnel en su máquina y registra su agente en tu
   hub con la URL pública de su hook (y ahí se levanta la restricción de `callbackUrl` a
   localhost: pasa a ser la URL pública del hub). El hub pasa a ser el "orchestrator mínimo" del
   paper: el registry ya distingue qué nodo está detrás de cada agente. Health-check (`ping`
   periódico) para marcar agentes online/offline en la UI.
3. **Docker sandbox**: empaquetar el nodo (awb + claude autenticado + sandbox) en un container,
   cumpliendo la promesa de aislamiento del paper.

## 7. Fases 3–4 (sin cambios respecto al paper)

- **Fase 3 — orquestación**: routing por capacidad/tags, retry en otro nodo, split de jobs.
- **Fase 4 — ledger/points**: recién cuando haya más de un operador real.

## 8. Orden de ejecución sugerido (fase 1)

| # | Entregable | Verificación |
|---|---|---|
| 1 | Callback en awb (§4.2) | `curl` al hook con `callbackUrl` apuntando a un `nc`/server de prueba → llega el resultado del run |
| 2 | Hub: DB + API + runner + CLI | `mesh submit` cierra el loop completo por terminal |
| 3 | UI servida por el hub | Loop completo desde el browser |
| 4 | Timeouts, token por job, pulido UI | Job que expira queda `failed`; secretos nunca visibles |

Estimación honesta: el hub es del mismo tamaño que el broker de awb (~600 líneas); los pasos 1–2
son un día de trabajo tranquilo, 3–4 otro más.

## 9. Decisiones tomadas por defecto (avisar si querés otra cosa)

- **Sin Flowise**: el proyecto usa exclusivamente awb + Claude Code como tipo de agente. Si algún
  día se suma otro runtime, el registry ya lo soporta (es solo otro `hookUrl`).
- **Stack del hub**: Node 24 + `node:sqlite` + TS directo, igual que awb (cero fricción, cero build).
- **Callback en el body del evento** y no como opción del hook (§4.2), para no acoplar awb al hub.
- **Compartir = fase 2 con túnel**; la fase 1 es 100% local para validar el loop sin exponer nada.
- **UI vanilla** (sin React/framework): una página, estética del concept paper.
