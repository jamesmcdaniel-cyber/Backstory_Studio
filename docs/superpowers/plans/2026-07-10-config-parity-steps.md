# WS10: Config-Parity Steps + Approvals Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec §10 + approvals inbox: three new step families reaching MS Agent-flows parity — Variables (typed symbol table), Data operations (7 pure transforms), Human review "Request information" (first-class pause) — plus the product's first surface for deciding pending approvals.

**Architecture:** Three new node types (`variable`, `data`, `humanReview`) enter the graph union with pure, heavily-tested interpreter semantics; the builder UX (picker groups, drawer/card editors, canvas titles, token tree) and copilot awareness follow; the approvals inbox is a standalone page over the existing approvals API. Field-level UX details live in `docs/superpowers/specs/references/2026-07-09-ms-config-settings.md` — implementers read it.

**Tech Stack:** zod graph schema, pure interpreter (`node:test` TDD), Next.js, existing approvals API.

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Baseline at plan time: 476 pass / 6 skip local (500/2 in CI-mode), 4 pre-existing lint warnings. Never run dev/build/prisma; CI-mode gate uses a SESSION-UNIQUE scratch DB (see memory `ci-github-actions-gate`).
- **New-node-type ripple checklist** — every task adding a node type MUST touch ALL of these or state why not: `src/lib/flows/graph.ts` (zod union), `src/lib/flows/mutate.ts` (StepType default data), `src/lib/flows/validate.ts`, `src/features/flows/interpret.ts`, `src/lib/flows/copilot-ops.ts` (STEP_TYPES membership — copilot can't add unlisted types), copilot grounding `graphRules` (`src/lib/flows/copilot-grounding.ts`), `src/lib/flows/builtin-catalog.ts` (picker manifest), `src/components/flows/flow-canvas.tsx` (titleFor/subtitleFor/icon), `src/components/flows/step-card.tsx` + `step-drawer.tsx` (editors + NODE_TYPES select), `src/lib/flows/token-text.ts` `stepLabelsOf` (generic capitalize covers it — verify), chat OPS_CONTRACT add-op type list (`src/app/api/flows/copilot/chat/route.ts`).
- Plain-English UI: no raw enums/`{{`; validation messages follow the house style (`{label} needs …`).
- Tokens stay canonical in storage; variables expose as `{{var.<name>}}`; chips must humanize them (`friendlyTokenLabel` gains a `var.` rule: `Variable › <name>`).
- MS reference doc governs field sets, required markers, and copy tone — not pixel cloning.

---

### Task 1: Variables — schema + interpreter + validation (TDD)

**Files:** graph.ts, mutate.ts, interpret.ts, validate.ts, token-text.ts (+ their test files; interpreter tests in `src/features/flows/__tests__/interpret.test.ts` — extend)

**Design (Produces):**
- Node `{ type: 'variable', data: { op: 'initialize' | 'set' | 'increment' | 'decrement' | 'appendArray' | 'appendString', name: string, varType?: 'boolean' | 'integer' | 'float' | 'string' | 'object' | 'array' (initialize only, default 'string'), value?: string (templated), label?, note? } }`
- Interpreter context gains a `variables: Record<string, unknown>` map; `resolveTemplate` resolves `var.<name>` paths (find where `step./trigger./item` paths resolve — `src/features/flows/context.ts` — and add the `var.` root).
- Semantics: initialize coerces `value` to `varType` (invalid coercion → step fails with plain message); set replaces (templated value, JSON-parsed when the var is object/array); increment/decrement require numeric var, `value` optional amount default 1; appendArray pushes (var must be array); appendString concatenates (var must be string). Step output = the new variable value (so `{{step.<id>.output}}` also works).
- Validation: non-initialize ops must reference a variable initialized EARLIER (upstream reachability — reuse/adapt however validate orders nodes; if order isn't derivable cheaply, validate existence anywhere in the graph and let the interpreter fail cleanly at runtime — choose, document); duplicate initialize names → error; increment/decrement on non-numeric initialize varType → error.
- `friendlyTokenLabel`: `var.deal_count` → `Variable › deal_count`.

**Key interpreter tests (write first, RED→GREEN):** initialize+set+read across steps; increment default 1 and explicit amount; decrement; appendArray onto initialized array; appendString; set with templated value referencing a prior step; initialize integer with non-numeric value fails with message; increment on string var fails; `{{var.x}}` resolves inside an agent step's input.

- [ ] Tests → implement → full gate → commit `feat(flows): variables — typed symbol table steps with {{var}} tokens`

---

### Task 2: Data operations — pure ops + node (TDD)

**Files:** NEW `src/lib/flows/data-ops.ts` (+ test), graph.ts, mutate.ts, interpret.ts, validate.ts

**Design (Produces):**
- Node `{ type: 'data', data: { op: 'compose' | 'parseJson' | 'join' | 'csvTable' | 'htmlTable' | 'filterArray' | 'select', input?: string (templated; from-source for most ops), separator?: string (join), schema?: string (parseJson, optional JSON Schema text), clauses?: ConditionClause[] (filterArray — reuse the condition clause shape + evalClause), fields?: { name: string, value: string }[] (select/compose object mode), label?, note? } }`
- Pure `runDataOp(op, resolvedConfig): { output: unknown } | { error: string }` in data-ops.ts — NO interpreter imports; interpret resolves templates then calls it.
- Semantics (MS parity, pragmatic): compose → passthrough of resolved input (string or parsed JSON); parseJson → JSON.parse with plain-english error (schema text stored but validation optional v1 — document); join → array→string with separator (structured input via the same coercion loops use — reuse `asStructured`/`loopItems` helpers from context if importable purely, else duplicate minimal coercion with a comment); csvTable/htmlTable → array-of-objects → CSV string / HTML `<table>` string (escape cells!); filterArray → filter items where clauses pass (reuse `evalClause` semantics — check import purity; item exposed as the clause left/right resolution context `{{item.x}}` — mirror how loop clauses resolve, or accept dot-path field refs on the item: choose the simplest consistent with the existing filter node and document); select → map array items to objects with the given name/value field mappings (`value` supports `{{item.x}}`).
- Note in code + report: existing `transform`/`filter` node types stay untouched; `data` supersedes them for new graphs (picker copy will steer — Task 4).
- Validation: required per-op fields (input for all; separator optional default ','; fields non-empty for select), house-style messages.

**Key tests:** each op happy path; csv/html escaping (`<script>` in a cell, commas/quotes in CSV); parseJson failure message; filterArray with eq/contains on item fields; select mapping with missing source fields (→ null, not crash); join on non-array input (coerces single item or fails cleanly — pick + test).

- [ ] Tests → implement → full gate → commit `feat(flows): data operation steps — compose, parse, join, tables, filter, select`

---

### Task 3: Human review "Request information" — first-class pause (TDD where pure)

**Files:** graph.ts, mutate.ts, interpret.ts, validate.ts, `src/features/flows/execute-flow.ts`

**Design (Produces):**
- Node `{ type: 'humanReview', data: { message: string (required, templated), assigneeUserId?: string, label?, note? } }`
- Interpreter: executing the node returns the SAME pause control agent ask_user uses (`{ kind: 'pause', nodeId, question: resolvedMessage }` — trace interpret's pause path from `res.waiting`) — NO agent execution involved. Resume: when `node.resume` is true for a humanReview node, its output = the reply string (interpret receives the reply how? — trace how agent resume gets `job.reply` through execute-flow's runAgent; humanReview needs the reply available in interpret: thread it via the interpret options for the resume node — likely a small `resumeReply?: string` option; keep it minimal).
- execute-flow: persist the FlowRunStep waiting row for humanReview pauses with `{waiting: {kind: 'input', question}}` (mirror the agent branch; humanReview is interpreter-persisted or adapter-persisted? — decide: give it its own tiny adapter-ish persist in the onStep path or persist in the pause branch; follow whichever pattern requires least new machinery — document). Notify: `notify({ type: 'flow.needs_input', level: 'action', link: /flows/<flowId>/activity })` to the assignee (or run owner when unset) on pause — mirror the flow-approval notify shape.
- WS8 reply machinery then works unchanged (banner shows the message; reply resumes; run-panel/activity already render kind 'input').
- Validation: empty message → error `'{label} needs a message for the reviewer.'`.

**Key tests (interpreter):** humanReview pauses with resolved message (templated from a prior step); resume with reply → output equals reply, downstream step sees `{{step.<id>.output}}`; empty-message validation.

- [ ] Tests → implement → full gate → commit `feat(flows): request-information steps — flows pause for a human without an agent`

---

### Task 4: Builder UX + copilot awareness for all three families

**Files:** builtin-catalog.ts, flow-picker.tsx (verify manifest renders groups), flow-canvas.tsx, step-card.tsx, step-drawer.tsx, copilot-ops.ts, copilot-grounding.ts, chat route OPS_CONTRACT, data-tree (variables root)

**Work:**
- Picker: `Variables` group (6 leaves seeding `variable` nodes with the right `op` + copy from the reference doc), `Data operations` group (7 leaves), `Human review` leaf (this replaces the WS2-era DEFERRED "Human review" entry — remove the deferral note). Icons/colors approximating the reference (purple/violet/blue) using existing icon set.
- Drawer + expanded card editors per family, following the reference field sets: variable name as a SELECT of initialize-declared names for non-initialize ops (derive from the graph — upstream initializes; free text for initialize) + varType select + value (TokenTextEditor, templated); data op fields per op (input TokenTextEditor, separator plain input, clauses editor reusing the condition clause UI, select fields KV-style with token values); humanReview message (TokenTextEditor, multiline) + assignee select (org members — check what user lists the builder already has; if none cheaply available, v1 = run owner only with helper copy, document).
- Canvas: titleFor/subtitleFor for the three types (humanized: 'Set variable deal_count', 'Parse JSON', 'Request information'); status colors default.
- DataTree: a `Variables` root listing initialized variables upstream (`{{var.<name>}}` tokens, typed) — extend `buildDataTree` source with the graph's initializes (page builds the source — find it).
- Copilot: STEP_TYPES + grounding graphRules describing the three node types' data shapes + chat OPS_CONTRACT type list.
- Validation UX rides existing machinery (badges/banners).

- [ ] Implement → gate → commit `feat(flows): variables, data operations, and human review in the builder + copilot`

---

### Task 5: Approvals inbox

**Files:** NEW `src/app/approvals/page.tsx` (+ nav wiring — find the app shell's nav list), read `src/app/api/approvals/route.ts` (list; verify query params/shape) + `src/app/api/approvals/[id]/route.ts` (decide POST shape)

**Work:**
- Page: org's approvals, default `pending` filter (chips: Pending / Decided); rows: summary (tool + provider humanized via `humanizeToolName` where sensible), requested time, source context (flow run vs agent execution — the `executionId` field holds either; a `flow.`-prefixed... NO: flow approvals carry FlowRun ids — detect by looking up? Keep v1 honest: show the summary + time; link 'View activity' when the payload/notification context allows, else no link — read what the approval row actually carries and render what's reliably there, document); Approve / Reject buttons → POST `/api/approvals/[id]` (read exact body/response; handle the `superseded`/already-decided response states with plain copy 'This approval was superseded by a newer request.' etc.); optimistic row removal on decide + refetch.
- Nav: 'Approvals' entry with a pending-count badge if cheaply derivable (a count fetch on shell load is fine; skip live badge if the shell has no such pattern — document).
- Notification bell: `agent.needs_approval` / `flow.needs_approval` notifications ALSO link here? Bell routing was just set to flow activity — leave bell as-is, the inbox is additive.
- Empty state: 'Nothing waiting on you.'

- [ ] Implement → gate → commit `feat(approvals): an inbox to decide pending approvals`

---

### Task 6: Final verification + review + push

- [ ] Full local gate; whole-workstream opus review (emphasis: interpreter regressions for EXISTING node types, XSS in htmlTable, variable-name injection into token resolution, approvals decide races from the inbox); fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB + build; push; confirm CI green.
