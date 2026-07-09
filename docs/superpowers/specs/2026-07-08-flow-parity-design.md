# Flow Feature Parity Design

**Date:** 2026-07-08
**Status:** Approved
**Goal:** Bring the Backstory Studio flow builder to full functional parity with Microsoft Copilot Studio "Agent flows" — the designer experience, step wiring, trigger execution, and a copilot that orchestrates flows so users don't build node by node.

## Context

The flow feature already has: a hand-rolled vertical canvas (`src/components/flows/flow-canvas.tsx`), step cards, a config drawer (`step-drawer.tsx`), a zod graph schema with 11 node types (`src/lib/flows/graph.ts`), a tested interpreter (`src/features/flows/interpret.ts`), manual + webhook execution, publish/versioning columns, MCP tool catalog (`src/lib/flows/tool-catalog.ts`), graph validation (`src/lib/flows/validate.ts`), one-shot copilot generation, undo/redo, and run polling.

Gaps vs. the Microsoft reference: trigger/action picker browsing UX, typed manual-trigger inputs, inline node configuration, "Run an agent" config parity (structured responses → downstream tokens), toolbar surfaces (flow checker, test mode, version history), schedule/signal triggers that don't actually dispatch, and a copilot that is one-shot and ungrounded.

## Decisions made

| Decision | Choice |
|---|---|
| Scope | Full parity, built in ordered workstreams |
| Config surface | Hybrid: primary fields inline in the expanded StepCard, drawer for deep/advanced config |
| Catalog scope | MCP connections + built-ins (no curated directory this effort) |
| Trigger execution | Full parity: schedule AND signal triggers dispatch for real |
| Copilot | Both phases: grounded one-shot first, then conversational edit loop |
| Toolbar | All three: flow checker, test mode, version history |
| Canvas platform | Keep the hand-rolled vertical spine; no React Flow migration |
| Favorites persistence | localStorage (per-user cross-device later if needed) |
| Schedule dispatch | Vercel cron → API route (not the BullMQ worker) |

## Build order (workstreams)

1. Step wiring core
1.5. Backstory MCP native connection + onboarding gate (added 2026-07-08)
1.75. Canvas UX parity (added 2026-07-08)
1.9. Agent memory & intelligence (added 2026-07-08, expanded same day — needs its own design pass; likely decomposes into sub-workstreams):
   - **Input memory:** when an agent pauses with "needs your input" and the user answers, persist the question/answer pair (per user+agent) and store it in the knowledge graph (existing graph-RAG store / indexExecution path) so later runs don't re-ask and other tasks/agents can reuse it.
   - **Run-to-run memory:** agents retain distilled learnings from previous runs (what worked, data found, decisions made), retrieved as context on the next run.
   - **Goal understanding:** agents understand the larger goal behind a task (goal object or inferred), evaluate output against it, and self-optimize each run (e.g. carry forward a self-critique note).
   - **Proactive suggestions:** surface suggestions to the user on what would help accomplish the goal better (missing connections, data gaps, prompt improvements) — likely rendered in the activity pane and/or flow checker warnings.
   - **Strategize mode:** for complicated tasks, an explicit plan-then-execute phase (think-through visible in the process log).
   - **Deeper graph-RAG leverage:** raise retrieval quality/recall in `retrieveContext`/`getGraphRagStore` usage — entity-linking run outputs, richer correlated-context injection, and feedback of run results into the graph.
   - Open design questions: memory schema + decay, per-user vs org scope, token budget for injected context, opt-outs, and how suggestions are actioned.
1.95. AI template finder (added 2026-07-08 — needs its own design pass): replace the Explore page's "Search templates and skills…" text search with an AI assistant search — the user describes what they want to accomplish and it suggests the closest-matching templates, or says none match. Likely build: embed template name/description/category (existing embeddings infra: `embedQuery`/`embedTexts`/`cosineSimilarity` in `src/lib/rag/embeddings.ts`), rank by similarity with a floor, LLM re-rank/explanation on top. Open design questions: keep plain-text filter as fallback, latency budget, and whether skills are included in the match set.
2. Picker/catalog UX
3. Toolbar surfaces (checker, test, versions)
4. Trigger execution parity (schedule + signal)
5. Copilot phase 1 (grounded one-shot)
6. Copilot phase 2 (conversational builder)

Each workstream lands independently; the builder keeps working throughout. Each gets its own implementation plan derived from this spec.

---

## 1. Step wiring core

### Manual trigger typed inputs

The trigger node gains `inputs: TriggerInputField[]`:

```ts
type TriggerInputField = {
  id: string
  name: string
  type: 'text' | 'boolean' | 'file' | 'email' | 'number' | 'date'
  description?: string
  required: boolean
}
```

UI: manual-trigger StepCard renders "+ Add an input" → chip row of the six types (Text, Yes/No, File, Email, Number, Date), then an inline row per input (name, description, required toggle, delete).

These fields drive:
- Datatree tokens for downstream steps: `{{trigger.fieldName}}`
- The Test-mode input form (`test-input-panel.tsx` becomes schema-driven from these fields)
- Webhook payload validation for published flows

Storage: trigger node data inside the graph JSON. Schema changes in `src/lib/flows/graph.ts` and `src/lib/flows/trigger.ts`. No Prisma migration.

### Hybrid inline config

StepCard gains an expanded state for the selected node showing its **primary** fields inline:
- HTTP: URI, Method, Headers, Queries, Body
- Agent: agent picker, message
- Tool: required args
- Condition/Switch/Loop/etc.: their core expressions

An "Advanced parameters" collapsed section at the card bottom shows "Showing N of M / Show all" for the rest (retries, timeout, cookies, onError).

The drawer remains for deep editing (raw JSON schema editors, output field mapping), opened via the card's expand-panel icon.

**Single source of truth:** a per-node-type field manifest module declares every field with `surface: 'primary' | 'advanced' | 'drawer'`; one shared form-renderer powers both StepCard and drawer.

### Dynamic tokens everywhere

Every text-accepting field in both surfaces gets the datatree picker (`data-tree.tsx`) via an affordance on focus, inserting `{{nodeId.field}}` tokens rendered as pills. Token sources:
- Trigger inputs
- HTTP output fields (`schema-fields.ts`)
- Tool output schemas
- Agent structured responses (below)

### Run an agent parity

Agent node config gains:
- Agent dropdown with refresh + "New agent" (links to agent creation)
- Message textarea with token support
- "Request human assistance when unsure" toggle → maps to the existing agent ask-user/pause mechanism in `execute-flow.ts`
- **Agent response**: "Text only" (default) vs "Structured" — a property-list schema builder (name, type, description). When structured, the interpreter requests schema-constrained output from `runAgentExecution` and the properties become downstream datatree tokens.

---

## 1.75. Canvas UX parity (added 2026-07-08, user reference screenshots)

The builder canvas must read like the Copilot Studio designer, not a form stack:

- **Collapsed cards by default.** Every step card renders compact — icon, title, (subtitle), status, ⋯ menu — with NO config form. Only the **selected** card expands to show its inline body (Section 1's hybrid config), matching the reference screenshot. Special case: a card with a single primary affordance (manual trigger's "+ Add an input", Respond-style "+ Add an output") may show that affordance while collapsed, as MS does.
- **Connector treatment.** Between cards: a vertical line with an arrowhead into the next card and a circular ⊕ insert button centered on the line (replacing the current bare plus). Same connector inside branch containers.
- **Selection affordance.** Clicking anywhere on a collapsed card selects + expands it; clicking the canvas background deselects (collapsing all). Expand/collapse animates (the `motion` library is already a dependency).
- **General freshness.** Card corner radius/shadow/spacing tuned to the reference; dot-grid backdrop stays. Deeper chrome parity (left zoom/fit-view rail, minimap, canvas search) belongs to Workstream 3's toolbar work — noted there, not here.

The broader "not as user-friendly as MS" gap is carried by the already-planned workstreams: 2 (picker/catalog UX) and 3 (toolbar surfaces). This section covers only the canvas card/connector behavior.

---

## 1.5. Backstory MCP native connection + onboarding gate

*Added 2026-07-08 mid-execution at user request.*

**Native connection.** The Backstory MCP server (`https://mcp.backstory.ai/mcp`, OAuth 2.0) is included for every user on the platform — it appears in the connections list and the flow tool catalog by default, without the user having to add it manually. The codebase already has `BackstoryMcpClient` / `backstoryMcpConfigured` (`src/lib/mcp/backstory-mcp.ts`) — this workstream surfaces it as a first-class, always-present connection rather than an optional one.

**Onboarding gate.** Users must complete their Backstory MCP OAuth connection before using the rest of the platform: until the connection is authorized and active, the app directs them to a setup step (connect screen with the OAuth flow) and blocks the main surfaces (flows, agents, dashboard). Once connected, the gate never reappears unless the connection is revoked or expires without refresh.

**Scope notes (to detail at planning time):**
- Where the gate lives (middleware/layout-level check vs per-page), and which routes are exempt (auth, connect, terms/privacy).
- Connection status source of truth: `McpConnection` row for the Backstory server, per user or per org.
- The catalog treats the Backstory connection like any other MCP connection (tools appear in pickers, flows can call them), but it is not deletable — only re-authorizable.

---

## 2. Picker / catalog UX

One picker component with two modes (`trigger` | `action`), replacing the drawer's current type selection. Rendered centered on empty canvas ("Add a trigger") and anchored near the insert caret mid-flow ("Add an action").

Structure:
- **Search** — fuzzy across built-ins, AI capabilities, MCP connections, and individual MCP tools; results grouped by source.
- **Favorites** — starrable items, persisted in localStorage.
- **AI capabilities** (action mode) — Run an agent (→ `agent` node), Run a prompt (→ `agent` node in a "prompt" mode: inline prompt + model, no saved agent required, executed via the same `runAgentExecution` path), Human review (→ the ask-user pause step).
- **Built-in tools** — drill-in groups:
  - HTTP → HTTP, HTTP Webhook
  - Control → Condition, Switch, Loop, Parallel, Stop
  - Data Operation → Transform, Filter
  - Variable
  - Trigger mode: HTTP/Webhook, Manually trigger, Schedule, Signal
- **By connector** — one card per active MCP connection; filter chips **All / Built-in / Connected** (MS's Standard/Premium/Custom licensing tiers intentionally dropped). Drill into a connection → its tools with descriptions; picking one creates a configured `tool` node.
- **Breadcrumb drill-in** — "Add a trigger › HTTP" with back navigation.

Selecting an item inserts the node via `mutate.ts` helpers, selects it, and expands its inline config so the user flows straight into configuration.

Data: new static built-ins manifest `src/lib/flows/builtin-catalog.ts` merged with the existing MCP catalog fetch. Unreachable MCP connections render a "connection issue" card state rather than disappearing.

---

## 3. Toolbar surfaces

Toolbar layout: undo/redo · Copilot · Version history · Flow checker · Test · | · Save draft · Publish. Save draft/Publish get dirty-state awareness and a "Draft"/"Published vN" status chip.

### Flow checker

- Right-docked panel (reuses `resizable-panel.tsx`) with **Errors** and **Warnings** sections sourced from `validateFlowGraph`.
- Click an item → select + scroll to the node; node renders a red/amber ring.
- Toolbar icon shows a live error-count badge (revalidated on graph change, debounced).
- Add a warnings tier to `validateFlowGraph` (e.g. unreachable node, downstream references a text-only agent's fields).
- Publish remains blocked on errors; warnings never block.

### Test mode

- Test button → right panel: schema-driven input form (from trigger inputs) → Run.
- Uses the existing execute endpoint + run polling; per-step statuses animate on canvas (`statusByNode` rings on StepCard).
- Completed steps show a compact I/O summary on the card; click opens the run inspector (`run-panel.tsx`) scoped to that step.
- This unifies test-input-panel, run-panel, and status polling into one coherent surface.

### Version history

New Prisma model:

```prisma
model FlowVersion {
  id          String   @id @default(cuid())
  flowId      String
  version     Int
  graph       Json
  trigger     Json
  note        String?
  publishedAt DateTime @default(now())
  publishedBy String
  // relation to Flow; @@unique([flowId, version])
}
```

- A row is written on every publish. Migration backfills current `publishedGraph` as v1 where present.
- Panel lists versions (vN, date, author) with **View** (read-only canvas overlay) and **Restore** (copies that graph into the draft; live published version untouched until re-publish).

---

## 4. Trigger execution parity

### Schedule triggers

- Trigger config fields: frequency (minutes/hours/days/weeks), interval, time-of-day, timezone, days-of-week — stored on the trigger node, normalized in `trigger.ts`.
- Dispatch: `vercel.json` cron → `POST /api/flows/dispatch-schedules` every 5 minutes, secret-authed.
- The route queries ACTIVE flows with schedule triggers, computes due-ness from a new indexed `nextRunAt` column on `Flow` (recomputed after each run), and invokes `runFlowExecution` on the published graph.
- Overlap guard: skip if that flow still has a `running` run.
- Rationale for cron-over-BullMQ: deploys are Vercel; no evidence the Fastify worker runs in prod. The dispatch route is thin, so migrating to the worker later is cheap.

### Signal triggers

- A signal is a named in-platform event.
- New service `emitFlowSignal(orgId, signal, payload)` + authed endpoint `POST /api/flows/signals/[name]`: finds ACTIVE flows with a matching signal trigger and starts runs with the payload as trigger input.
- Built-in emit points wired in this effort: **flow completed** (flows chaining flows) and **agent task completed**. The generic endpoint allows any platform code or external caller (API key) to emit.
- Signal trigger config: signal name picker (known names + free text), optional input field mapping.

### UI honesty

- Schedule trigger card shows "Next run: …"; webhook shows URL + secret controls; signal shows the listening name.
- DRAFT flows show "Activates when you publish" — dispatch only reads published graphs, consistent with webhook behavior.
- Schedule dispatch failures write a failed `FlowRun` (visible in history, never silent).

---

## 5. Copilot

Both phases share one **grounding-context builder** module that assembles: org agents (id, name, description, capabilities), MCP tool catalog (connections, tools, input schemas), the built-ins manifest, and trigger types.

### Phase 1: grounded one-shot

- Generation prompt (`api/flows/copilot/route.ts`) includes the grounding context.
- Enforced rules (prompt + post-validation): only real `agentId`s and tool names; every required tool arg filled with a literal or an upstream `{{token}}`; step outputs wired into downstream inputs; agents get structured response schemas when downstream steps consume their fields.
- After generation: run `validateFlowGraph`, feed errors back for up to 2 repair rounds.
- Response includes a **"needs attention"** list (e.g. missing connection) surfaced as amber badges on affected nodes and in the checker's warnings.

### Phase 2: conversational builder

- `copilot-panel.tsx` becomes a right-docked chat panel.
- Each turn sends chat history + current graph; the model returns a message plus **structured edit operations** (add/update/delete/rewire — the same vocabulary as `mutate.ts`; edits always go through the tested mutation helpers, never raw graph JSON).
- Edits apply immediately with a highlight pulse on touched nodes and land on the existing undo stack.
- The copilot narrates what it did and lists what still needs the user (pick an agent, connect a tool), each item linking to its node.
- Requests inexpressible as valid ops produce a clarifying question, not a broken graph.

---

## 6. Error handling & testing

### Error handling

- **Runtime:** per-step `onError` (fail/continue/retry) exposed via Advanced parameters. Schedule dispatch failures → failed `FlowRun` rows. Signal emission fire-and-forget for the emitter; each triggered flow gets its own run row.
- **Design-time:** the checker is the single funnel; publish blocked on errors only. Copilot "needs attention" feeds the warning surface.
- **Degraded catalog:** unreachable MCP connections show a "connection issue" picker state.

### Testing

Follow the existing pattern (`src/lib/flows/__tests__/`, `src/features/flows/__tests__/`):
- Unit: trigger-input schema/normalization; field-manifest rendering rules; builtin-catalog manifest; schedule due-ness (timezone/DST); signal matching; copilot edit-op application; structured-response token derivation.
- Routes: dispatch-schedules (due/not-due/overlap-skip); signals (auth, matching); versions (publish writes row; restore copies to draft).
- Interpreter: structured agent response propagation into context tokens.
- Verification locally = typecheck + lint + test (no local Supabase); builds validate on Vercel.

## Out of scope

- React Flow / canvas replatform
- Curated MCP server directory inside the picker
- Cross-device favorites persistence
- MS licensing-tier filters (Standard/Premium/Custom)
- Analytics/Activity tabs from the MS chrome
