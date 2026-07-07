# Flows — Visual Agent Pipelines

**Date:** 2026-07-07
**Status:** Approved design
**Author:** James McDaniel + Claude

## Problem

Agents run one autonomous task each. Sophisticated work — e.g. the SalesAI Upsell
Engine (pull accounts → score each → post a digest) — needs several agents wired
together with output threaded between them, some steps fanning out in parallel and
some gated on a condition. Today the only way to compose agents is the `run_agent`
tool: dynamic, LLM-driven delegation *inside* one orchestrator agent. That is
powerful but implicit and non-deterministic — you can't see or edit the pipeline,
and you can't watch it run step by step.

Users want an explicit, visual, deterministic way to build agent pipelines, modelled
on the Workato recipe builder (vertical Trigger → Actions canvas, per-step config
drawer, BUILD/TEST tabs, an AI copilot panel).

## Solution overview

Introduce **Flows**: a first-class saved artifact with its own data model, canvas,
and deterministic execution engine. A Flow is a graph of **steps**; each step runs
one of the workspace's existing **agents**. The runner executes steps in order,
threads each step's output into the next, evaluates conditions and loops, and records
**per-step status** live on the canvas.

Each agent step reuses the existing `runAgentExecution(...)` runtime, so tool
loading, MCP/Strata access, model routing, and ask-user handling all come for free.

Flows and `run_agent` are complementary:
- **`run_agent` tool** — dynamic, LLM-decided delegation inside a single agent run.
- **Flows** — explicit, visual, deterministic pipelines the user designs and inspects.

## Naming

The existing `WorkflowStep` / `WorkflowEvent` models are the internal per-agent
execution trace (one agent's tool-calling turns) and are unrelated. To avoid
collision, the user-facing name and models are **Flow** (`Flow`, `FlowRun`,
`FlowRunStep`).

## Data model (new Prisma models + migration)

```prisma
model Flow {
  id             String   @id @default(cuid())
  name           String
  description    String   @default("")
  status         String   @default("DRAFT")   // DRAFT | ACTIVE | DISABLED
  trigger        Json     @default("{}")       // { type: 'manual'|'schedule'|'signal', ... }
  graph          Json     @default("{}")       // { nodes: [...], edges: [...] }
  visibility     String   @default("shared")   // shared | private
  organizationId String
  userId         String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  runs           FlowRun[]
  @@index([organizationId, updatedAt])
  @@map("flows")
}

model FlowRun {
  id             String   @id @default(cuid())
  flowId         String
  status         String   @default("running")  // running | succeeded | failed | waiting
  trigger        Json     @default("{}")
  input          Json     @default("{}")
  output         Json?
  error          String?
  startedAt      DateTime @default(now())
  finishedAt     DateTime?
  organizationId String
  userId         String?
  flow           Flow     @relation(fields: [flowId], references: [id], onDelete: Cascade)
  steps          FlowRunStep[]
  @@index([flowId, startedAt])
  @@map("flow_runs")
}

model FlowRunStep {
  id               String    @id @default(cuid())
  flowRunId        String
  nodeId           String                       // matches a node id in Flow.graph
  agentExecutionId String?                      // links to the real AgentExecution this step produced
  order            Int       @default(0)
  status           String    @default("queued") // queued | running | succeeded | failed | skipped | waiting
  input            Json      @default("{}")
  output           Json?
  error            String?
  startedAt        DateTime?
  finishedAt       DateTime?
  run              FlowRun   @relation(fields: [flowRunId], references: [id], onDelete: Cascade)
  @@index([flowRunId, order])
  @@map("flow_run_steps")
}
```

`FlowRunStep.agentExecutionId` lets a step's full transcript be inspected via the
existing execution UI, and powers live per-step status polling on the canvas.

### Graph JSON shape

```jsonc
{
  "nodes": [
    { "id": "trigger", "type": "trigger", "data": { "trigger": { "type": "manual" } } },
    { "id": "n1", "type": "agent",
      "data": { "agentId": "…", "label": "Pull accounts", "input": "{{trigger.input}}", "onError": "stop" } },
    { "id": "n2", "type": "loop",
      "data": { "label": "Score each", "over": "{{step.n1.output}}", "concurrency": 5, "body": ["n3"] } },
    { "id": "n3", "type": "agent", "data": { "agentId": "…scorer", "input": "{{item}}" } },
    { "id": "n4", "type": "condition",
      "data": { "label": "High readiness?", "left": "{{step.n3.output.score}}", "op": "gt", "right": "80" } },
    { "id": "n5", "type": "agent", "data": { "agentId": "…slack", "input": "{{step.n2.output}}" } }
  ],
  "edges": [
    { "id": "e1", "source": "trigger", "target": "n1" },
    { "id": "e2", "source": "n1", "target": "n2" },
    { "id": "e3", "source": "n2", "target": "n4" },
    { "id": "e4", "source": "n4", "target": "n5", "branch": "true" }
  ]
}
```

## Node types (full logic)

| Type | Purpose |
|------|---------|
| `trigger` | Exactly one, at the top. Lives on the Flow, not the inner agents. v1 executes `manual` + `schedule` (reuses the agent scheduler); `signal` is stored in the model but wired to the existing signal→subscription infra in Phase 2. |
| `agent` | Run a workspace agent with a resolved `input` template. `onError`: `stop` \| `continue`. |
| `condition` | Structured if/else: `{left, op, right}` → routes to the `true`/`false` branch edge. |
| `loop` | For-each over a list from a prior step, bounded `concurrency`. The parallel fan-out primitive. Collects child outputs into an array. |
| `parallel` | Run several branches concurrently, merge outputs. |

**Deferred to Phase 2:** freeform `transform` nodes, advanced on-error routing.

## Execution engine — `src/features/flows/execute-flow.ts`

`runFlowExecution({ flowId, organizationId, userId, input, flowRunId? })`:

1. Load the Flow graph; create (or resume) a `FlowRun`.
2. Traverse from the `trigger` node, maintaining `context = { trigger, step: { <nodeId>: { output } }, item? }`.
3. **agent node:** resolve `input` template against `context`; write a `FlowRunStep` (`running`); call
   `runAgentExecution({ agentId, organizationId, userId, input })`; store the string result as `output`
   (parsed to JSON when it parses); mark `succeeded`/`failed` per `onError`.
4. **condition node:** evaluate the structured comparison against `context`; follow the matching branch edge.
5. **loop node:** read the array at `over`; run the body subgraph per item with bounded concurrency
   (a small p-limit); collect results into an array output. Cap iterations.
6. **parallel node:** run branch subgraphs concurrently; merge into a keyed object output.
7. Finalize the `FlowRun` (`succeeded`/`failed`) with the terminal output.

**Determinism & safety:**
- Input templates use `{{step.n1.output.score}}` / `{{trigger.input}}` / `{{item}}` **token substitution**
  over a dot-path accessor — **no JS eval**.
- Conditions are **structured** (`{left, op, right}` with ops `eq|neq|gt|gte|lt|lte|contains|matches`), never
  freeform code.
- A step output that `JSON.parse`s is exposed structured (for `.score`, array iteration); otherwise it is text,
  with `contains`/`matches` ops and a "split lines" option for loops.

**Guards:** max total steps per run, max loop iterations, shared token budget (reuses the agent budget
mechanism), overall timeout.

**Ask-user inside a step (v1):** if `runAgentExecution` returns `waiting_for_input`, the `FlowRunStep` and the
`FlowRun` both go to `waiting`, surfacing the pending question. Resuming re-enters `runFlowExecution` with the
`flowRunId` and answered input, reusing the agent resume mechanics. (Accepted for v1: pausing the whole flow.)

## API routes (mirror `/api/agents`)

- `GET/POST/PUT/DELETE /api/flows` — CRUD, visibility-scoped (`agentVisibilityScope`), org-scoped.
- `POST /api/flows/[id]/execute` — start a `FlowRun` (manual trigger).
- `GET /api/flows/[id]/runs` and `/runs/[runId]` — run history + live per-step status for the canvas.
- `POST /api/flows/copilot` — `{ description, agents: roster }` → a draft `graph` (nodes/edges) via the LLM,
  constrained to the schema above and to existing agent ids. Basic scaffold; user edits after.
- Schedule-triggered flows integrate with the existing agent scheduler (the same mechanism that enqueues
  scheduled agent runs picks up `status: ACTIVE` flows whose `trigger.type === 'schedule'`).

## UI — `/flows` list + `/flows/[id]` builder

**Sidebar:** new nav entry **"Flows"** (Workflow / Share2 icon), between Explore and MCP Servers.

**`/flows` (list):** paginated flow cards (9/page, reusing `Pagination`/`paginate`) with name, description,
step count, status, last run; a **New flow** button; empty state.

**`/flows/[id]` (builder), Workato-style:**
- **Top bar:** editable flow name; **BUILD / TEST** toggle; **Save**; **Run** (manual execute); **Exit**.
- **Center canvas (vertical pipeline):** a Trigger card at the top, then numbered step cards joined by a
  connector line with a `+` insert button between and after steps. Condition nodes render as a labelled fork;
  loop nodes render as a container holding their body. In run/TEST mode each card shows a live status dot
  (queued/running/succeeded/failed/waiting) polled from `/runs/[runId]`.
- **Right config drawer** (opens on step click): choose node type (Agent / If-else / For-each / Parallel);
  for an agent step, a **searchable agent picker** over the workspace roster, an **input template** field with
  an insert-token helper (trigger input, prior step outputs, loop item), and `onError` behaviour.
- **Right-most Copilot panel:** a chat that calls `/api/flows/copilot` to scaffold or extend the graph from a
  natural-language description; the returned steps drop onto the canvas for editing.
- Reuses existing primitives (`Button`, `Skeleton`, `Pagination`, `IntegrationChip`) and follows the design
  guide.

## Phasing

Both phases are covered by this spec; **Phase 1 ships first** and delivers the full builder experience.

- **Phase 1 — foundation & builder:** models + migration; `runFlowExecution` (agent + condition + loop +
  parallel + guards + ask-user pause); CRUD/execute/runs/copilot APIs; `/flows` list + nav; `/flows/[id]`
  canvas + config drawer + live status; basic copilot panel.
- **Phase 2 — polish:** freeform `transform` nodes; advanced on-error routing; richer TEST mode (per-step
  input/output inspection, re-run-from-step); canvas zoom/pan.

## Testing

- Unit: template token resolver (dot-path, missing keys, `{{item}}`), structured condition evaluator (all ops,
  type coercion), JSON-vs-text output exposure, loop concurrency + iteration cap, graph traversal (branch
  selection, parallel merge), guard tripwires (max steps, token budget).
- Integration: `runFlowExecution` over a stubbed `runAgentExecution` for a linear, a fan-out (loop), and a
  branching flow; ask-user pause + resume; API CRUD/execute/runs happy-path + visibility scoping.
- Follows the repo convention: verify via `npm run typecheck && npm run lint && npm test` (local build lacks
  Supabase env by design; builds validate on Vercel).

## Out of scope (v1)

- Freeform code / transform nodes (Phase 2).
- Canvas zoom/pan, drag-to-reposition (vertical auto-layout only in v1).
- Re-run-from-step and per-step output inspection UI (Phase 2).
- Nested flows (a flow step running another flow) — agents only for now.
