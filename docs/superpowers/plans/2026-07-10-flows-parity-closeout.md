# Flows Parity Close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four flows parity gaps: (#1) condition/switch inside a loop/parallel body stop being a silent no-op; (#3) the inbound webhook trigger is visually and nominally distinct from the outbound HTTP action; (#4) a trigger-level filter condition gates a run before it starts; (#2) a loop/parallel that pauses mid-iteration resumes from its cursor instead of re-running prior iterations' side effects.

**Architecture:** #1 is a validation-checker addition (no engine behavior change — container bodies are flat ordered lists that can't branch; `filter` already handles per-item gating, so we flag condition/switch-in-container as an error and steer to `filter`). #3 is icon/color/label edits across three surfaces. #4 adds an optional `condition` to the trigger config, evaluated with the existing `evalClause` at each trigger entry point before `runFlowExecution`, plus a drawer editor. #2 is the substantive one: persist per-iteration body-step outputs keyed `nodeId#index`, thread an iteration cursor so `execBody`/resume skip completed iterations and completed per-iteration body nodes, and match a resumed approval/reply to the specific iteration that paused.

**Tech Stack:** TypeScript, the flow interpreter (`src/features/flows/interpret.ts`), executor (`src/features/flows/execute-flow.ts`), validator (`src/lib/flows/validate.ts`), React builder (`src/components/flows/*`), node:test + the component-test harness (`src/test-support/jsdom-env.ts`, run `.test.tsx` via `TSX_TSCONFIG_PATH=tsconfig.test.json`).

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent (match surrounding files exactly).
- No raw `{{token}}` syntax shown to users in UI — plain-English chips + explicit validation messages (product mandate).
- Verification gate: `npm run typecheck && npm run lint && npm test`. DB-backed and `.tsx` tests self-skip / run per existing conventions; the full run uses the package.json `test` script (already includes `.test.tsx` via `tsconfig.test.json`).
- No schema migration for #1/#3. #4 and #2 add optional fields to the `Flow.trigger` JSON blob and `FlowRunStep` usage respectively — no Prisma column migration (trigger is `Json`; FlowRunStep.nodeId is already `String`).
- Engine tests live in `src/features/flows/__tests__/interpret.test.ts` (pure, no DB). Resume/executor DB behavior: `src/features/flows/__tests__/execute-flow-resume.test.ts` (gated on `TEST_DATABASE_URL`, run against a throwaway pgvector DB).
- Commits direct to `main`; push only at the final task's isolated-worktree gate (typecheck/lint/test/build). Concurrent-session caveat: commit only files you changed.
- Order: Task 1 (#1) → Task 2 (#3) → Task 3 (#4) → Task 4 (#2, largest, heaviest review).

---

### Task 1: Condition/Switch inside a container is a validation error (#1)

**Files:**
- Modify: `src/lib/flows/validate.ts`
- Test: `src/lib/flows/__tests__/validate.test.ts`

**Interfaces:**
- Consumes: `add(issues, level, code, message, nodeId)` (validate.ts:94); the graph's `loop.data.body: string[]` and `parallel.data.branches: string[][]`.
- Produces: a new error code `CONTAINER_BRANCHING_UNSUPPORTED` on any `condition`/`switch` node whose id is inside a loop body or parallel branch.

- [ ] **Step 1: Write the failing test**

In `src/lib/flows/__tests__/validate.test.ts`, add (adapt the file's existing `validateFlowGraph(graph, context)` call shape — read a neighboring test first):

```ts
test('condition inside a loop body is flagged, not silently skipped', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'c1', type: 'condition', data: { left: '{{item}}', op: 'eq', right: 'x' } },
      { id: 'lp', type: 'loop', data: { over: '{{trigger.input}}', body: ['c1'] } },
    ],
    edges: [{ source: 'trigger', target: 'lp' }],
  }
  const { issues } = validateFlowGraph(graph as never, { agents: [], toolCatalog: [] })
  const hit = issues.find((i) => i.code === 'CONTAINER_BRANCHING_UNSUPPORTED')
  assert.ok(hit, 'expected CONTAINER_BRANCHING_UNSUPPORTED')
  assert.equal(hit?.level, 'error')
  assert.equal(hit?.nodeId, 'c1')
})

test('a switch on the main chain is NOT flagged', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's1', type: 'switch', data: { cases: [] } },
    ],
    edges: [{ source: 'trigger', target: 's1' }],
  }
  const { issues } = validateFlowGraph(graph as never, { agents: [], toolCatalog: [] })
  assert.equal(issues.find((i) => i.code === 'CONTAINER_BRANCHING_UNSUPPORTED'), undefined)
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npx tsx --test src/lib/flows/__tests__/validate.test.ts`
Expected: FAIL — no `CONTAINER_BRANCHING_UNSUPPORTED` issue produced.

- [ ] **Step 3: Implement**

In `validate.ts`, inside `validateFlowGraph`, after the node map is built and before/within the per-node loop, compute the set of container-contained node ids and flag condition/switch among them. Add near the other per-node checks:

```ts
  // Container bodies are flat ordered lists — they can't host branch edges, so
  // a condition/switch inside a loop/parallel body would silently never branch.
  // Flag it loudly and steer to the `filter` node for per-item gating.
  const containedIds = new Set(
    nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  for (const node of nodes) {
    if ((node.type === 'condition' || node.type === 'switch') && containedIds.has(node.id)) {
      add(
        issues,
        'error',
        'CONTAINER_BRANCHING_UNSUPPORTED',
        `${nodeLabel(node)} can't branch inside a loop or parallel branch yet — move it to the main flow, or use a Filter step to keep only the items you want.`,
        node.id,
      )
    }
  }
```

Use the file's existing `nodes` binding and `nodeLabel` helper (read the file — if the local variable is named differently, e.g. `graph.nodes`, match it).

- [ ] **Step 4: Run — verify GREEN**

Run: `npx tsx --test src/lib/flows/__tests__/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/validate.ts src/lib/flows/__tests__/validate.test.ts
git commit -m "fix(flows): condition/switch inside a loop/parallel body is now a validation error, not a silent no-op"
```

---

### Task 2: Disambiguate the webhook trigger from the HTTP action (#3)

**Files:**
- Modify: `src/components/flows/flow-picker.tsx` (webhook trigger icon + tone)
- Modify: `src/components/flows/flow-canvas.tsx:188` (card title)
- Modify: `src/components/flows/step-drawer.tsx:1424` (trigger-type dropdown option label)
- Modify: `src/lib/flows/builtin-catalog.ts:98` (keep picker label canonical — see below)
- Test: `src/components/flows/__tests__/trigger-labels.test.tsx` (harness)

**Interfaces:**
- Consumes: `TRIGGER_ICON`/`TRIGGER_TONE`/`GROUP_ICON`/`GROUP_TONE` maps in flow-picker.tsx; the `Webhook` and/or `ArrowDownToLine` lucide icon (import from `lucide-react`).
- Produces: the webhook trigger renders with a DISTINCT icon and color from the HTTP action group, and the single canonical name **"When an HTTP request is received"** on all three surfaces.

- [ ] **Step 1: Canonical name across three surfaces**

- `flow-canvas.tsx:188`: change `return 'Webhook trigger'` → `return 'When an HTTP request is received'`.
- `step-drawer.tsx:1424`: change `<option value="webhook">Webhook (external)</option>` → `<option value="webhook">When an HTTP request is received</option>`.
- `builtin-catalog.ts:98`: already `'When an HTTP request is received'` — leave as the canonical.

- [ ] **Step 2: Distinct icon + color for the webhook trigger**

In `flow-picker.tsx`, import a distinct icon (`import { Webhook } from 'lucide-react'` — or `ArrowDownToLine` if `Webhook` isn't in the installed lucide version; verify by grepping `node_modules/lucide-react/dist/lucide-react.d.ts` for the name). Then:
- `TRIGGER_ICON.webhook`: `Globe` → `Webhook` (distinct from the HTTP action's `GROUP_ICON.http = Globe`).
- `TRIGGER_TONE.webhook`: `'bg-emerald-600 text-white'` → `'bg-violet-600 text-white'` (distinct from the HTTP action's emerald).

Leave `GROUP_ICON.http` / `GROUP_TONE.http` (the outbound HTTP action) as `Globe` / emerald.

- [ ] **Step 3: Write a rendering test (harness)**

`src/components/flows/__tests__/trigger-labels.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { FlowCanvas } from '../flow-canvas'
import type { FlowGraph } from '@/lib/flows/graph'

test('a webhook trigger card reads "When an HTTP request is received", not "Webhook trigger"', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } }], edges: [] } as never
  const { container } = render(React.createElement(FlowCanvas, {
    graph, agentName: () => '', agents: [], toolCatalog: [],
    statusByNode: {}, selectedId: null,
    onSelect: () => {}, onChangeNode: () => {}, onInsertAfter: () => {}, onAppendBranch: () => {}, onBackgroundClick: () => {},
  } as never))
  assert.ok((container.textContent || '').includes('When an HTTP request is received'))
  assert.ok(!(container.textContent || '').includes('Webhook trigger'))
  cleanup()
})
```

Adapt the FlowCanvas required props to its actual signature (read `flow-canvas.tsx` props — pass no-op functions for required callbacks). If FlowCanvas is too prop-heavy to render in isolation, instead unit-test the pure title helper: extract/confirm the `type === 'webhook'` branch returns the canonical string and assert that directly.

- [ ] **Step 4: Run + gate + commit**

`npx tsx --test` on the new file (with `TSX_TSCONFIG_PATH=tsconfig.test.json`), then the full gate.

```bash
git add src/components/flows/flow-picker.tsx src/components/flows/flow-canvas.tsx src/components/flows/step-drawer.tsx src/components/flows/__tests__/trigger-labels.test.tsx
git commit -m "fix(flows): webhook trigger is visually + nominally distinct from the HTTP action (icon, color, one canonical name)"
```

---

### Task 3: Trigger-level filter condition (#4)

**Files:**
- Modify: `src/lib/flows/graph.ts` (trigger data: optional `condition`)
- Create: `src/lib/flows/trigger-condition.ts` (`triggerConditionPasses(trigger, input): boolean`)
- Modify: `src/app/api/flows/[id]/trigger/route.ts` (webhook entry), `src/features/flows/signals.ts` (signal entry), `src/app/api/cron/dispatch/route.ts` (schedule entry) — gate before `runFlowExecution`
- Modify: `src/components/flows/step-drawer.tsx` (trigger drawer: condition editor, reusing the condition-clause UI)
- Test: `src/lib/flows/__tests__/trigger-condition.test.ts`

**Interfaces:**
- Consumes: `evalClause(clause, ctx)` (src/features/flows/context.ts:94), `conditionClauseSchema` + `match: 'all'|'any'` shape (graph.ts:60,69-70), `FlowContext` (context.ts).
- Produces: `triggerConditionPasses(trigger: unknown, input: unknown): boolean` — true when no condition is set OR the condition passes against `{ trigger: { input } }`.

- [ ] **Step 1: Failing test for the pure gate**

`src/lib/flows/__tests__/trigger-condition.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { triggerConditionPasses } from '../trigger-condition'

test('no condition → always passes', () => {
  assert.equal(triggerConditionPasses({ type: 'webhook' }, { status: 'anything' }), true)
})

test('condition gates on the incoming payload', () => {
  const trigger = { type: 'webhook', condition: { match: 'all', clauses: [{ left: '{{trigger.input.status}}', op: 'eq', right: 'urgent' }] } }
  assert.equal(triggerConditionPasses(trigger, { status: 'urgent' }), true)
  assert.equal(triggerConditionPasses(trigger, { status: 'low' }), false)
})

test('match:any passes when one clause holds', () => {
  const trigger = { type: 'webhook', condition: { match: 'any', clauses: [
    { left: '{{trigger.input.a}}', op: 'eq', right: '1' },
    { left: '{{trigger.input.b}}', op: 'eq', right: '2' },
  ] } }
  assert.equal(triggerConditionPasses(trigger, { a: '9', b: '2' }), true)
  assert.equal(triggerConditionPasses(trigger, { a: '9', b: '9' }), false)
})
```

- [ ] **Step 2: Run — RED** (`npx tsx --test src/lib/flows/__tests__/trigger-condition.test.ts` → module not found).

- [ ] **Step 3: Implement the pure gate**

`src/lib/flows/trigger-condition.ts`:

```ts
/**
 * Trigger-level filter: gate a run BEFORE it starts. Returns true when the
 * trigger has no condition, or its clauses pass against the incoming payload.
 * Reuses the flow condition evaluator so operators/templating match condition
 * nodes exactly. A run that fails the gate is never created (no FlowRun row).
 */
import { evalClause } from '@/features/flows/context'
import type { FlowContext } from '@/features/flows/context'

type Clause = { left: string; op: string; right: string }
type TriggerCondition = { match?: 'all' | 'any'; clauses?: Clause[] }

export function triggerConditionPasses(trigger: unknown, input: unknown): boolean {
  const condition = (trigger as { condition?: TriggerCondition } | null | undefined)?.condition
  const clauses = condition?.clauses ?? []
  if (clauses.length === 0) return true
  const ctx = { trigger: { input }, step: {}, variables: {} } as FlowContext
  const results = clauses.map((clause) => evalClause(clause as never, ctx))
  return (condition?.match ?? 'all') === 'any' ? results.some(Boolean) : results.every(Boolean)
}
```

- [ ] **Step 4: Run — GREEN.**

- [ ] **Step 5: Schema + entry-point gating**

- `graph.ts` triggerNode data: it's currently `z.object({ trigger: z.any().optional() })` — the condition lives inside the `trigger` blob, so no schema change is strictly required (it's `any`). If the trigger data is typed more strictly elsewhere, add `condition: z.object({ match: z.enum(['all','any']).optional(), clauses: z.array(conditionClauseSchema).optional() }).optional()`. Verify and keep minimal.
- `src/app/api/flows/[id]/trigger/route.ts` (~line 53): before `runFlowExecution`, add:

```ts
    const trigger = triggerFromGraph(flow.publishedGraph ?? flow.graph)
    if (!triggerConditionPasses(trigger, input)) {
      return Response.json({ success: true, filtered: true, message: 'Trigger condition not met — run skipped.' })
    }
```

(Use the file's existing `input`/`flow` bindings and response idiom; import `triggerConditionPasses` and `triggerFromGraph`.)
- `src/features/flows/signals.ts` (~line 100): before `runFlowExecution`, `if (!triggerConditionPasses(trigger, input)) continue` (skip this flow, no run).
- `src/app/api/cron/dispatch/route.ts` scheduled-flow block (~line 249): before `runFlowExecution`, skip when `!triggerConditionPasses(trigger, parseFlowInput(trigger.input ?? ''))` — a scheduled trigger's "input" is its stored default; gate on that. (Lower value for schedule, but keep parity; wrap in the existing per-flow try/catch.)

Add a DB-gated assertion in `execute-flow-resume.test.ts` or a focused route test if practical; otherwise state in the report that entry-point wiring is verified by reading + typecheck (the pure gate carries the test coverage).

- [ ] **Step 6: Drawer editor**

In `step-drawer.tsx`'s trigger section, add an optional "Only run when…" condition editor reusing the existing condition-clause row UI (the same component/pattern the `condition` node uses — find it in step-drawer/step-card and reuse, don't duplicate). Writes to `trigger.condition = { match, clauses }`. Plain-English chips, no raw tokens. If the clause-row UI isn't easily reusable from the trigger context, scope this step to a minimal single-clause editor and note the follow-up.

- [ ] **Step 7: Gate + commit**

```bash
git add src/lib/flows/graph.ts src/lib/flows/trigger-condition.ts src/lib/flows/__tests__/trigger-condition.test.ts "src/app/api/flows/[id]/trigger/route.ts" src/features/flows/signals.ts src/app/api/cron/dispatch/route.ts src/components/flows/step-drawer.tsx
git commit -m "feat(flows): trigger-level filter condition — gate a run before it starts (webhook/signal/schedule)"
```

---

### Task 4: Loop/parallel resume-from-cursor (#2) — largest, heaviest review

**Files:**
- Modify: `src/features/flows/interpret.ts` (per-iteration keying + resume skip)
- Modify: `src/features/flows/execute-flow.ts` (persist per-iteration step rows; build `completed` with `nodeId#index` keys)
- Modify: `src/lib/flows/approval-decision.ts` (match a decision to the specific iteration)
- Test: `src/features/flows/__tests__/interpret.test.ts` (pure resume-cursor behavior) + `execute-flow-resume.test.ts` (DB, per-iteration persistence)

**Interfaces:**
- Consumes: the loop executor (`interpret.ts:530-548`), `execBody` (`interpret.ts:575-590`), the `completed` map (execute-flow builds it from `FlowRunStep` rows ordered by `order`), `shouldConsumeApprovalDecision` (approval-decision.ts:36).
- Produces: body-step outputs persisted and replayed under `${bodyNodeId}#${index}` keys; a paused loop iteration resumes without re-running completed iterations or completed body steps of the paused iteration; the resumed reply/approval targets the exact paused iteration.

- [ ] **Step 1: Failing pure test — resume skips completed iterations**

In `interpret.test.ts`, add a test using the existing test harness (read how the file constructs `interpretFlow` calls + a `runAgent` stub that can pause on a chosen iteration). The test: a loop over 3 items whose body is a single agent node that PAUSES on item 1 (index 1). First run pauses at item 1. Provide `completed` containing `body#0` (item 0's output) and resume with the reply for item 1; assert the resumed run does NOT re-invoke the agent for item 0 (track invocation indices in the stub), fires item 1 (with the reply) and item 2, and the loop output has all three items in order.

Concretely (adapt to the file's actual `interpretFlow` signature + stub style):

```ts
test('a loop that paused on item 1 resumes without re-running item 0', async () => {
  const calls: number[] = []
  const graph = /* trigger -> loop(body:[a]) over ['x','y','z'], a = agent node */
  // first run: runAgent pauses when ctx.loop.index === 1
  // resume run: opts.completed has { 'a#0': 'out0' }, opts.resumeNodeId 'a#1', opts.resumeReply 'answer'
  // assert calls does NOT include 0 on the resume run; includes 1 (resumed) and 2
})
```

Because this touches the interpreter's loop internals, the implementer must first read `interpret.ts:530-590` and `execute-flow.ts:200-260` to see exactly how `completed`, `resumeNodeId`, and loop `execBody` interact today, then design the `#index` keying to thread through: (a) `execBody` gains an `indexKey` (the `#i` suffix or '') so it reads/writes `completed[`${id}${indexKey}`]` and emits step rows with that nodeId; (b) the loop passes `#${index}` per item; (c) a fully-completed iteration (all its body ids present in `completed`) is skipped; (d) the pause control carries the iteration index so resume knows which `#i` to target.

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Implement per-iteration keying in the interpreter**

Thread an `indexKey: string` param through `execBody` (default `''` for the main chain / non-loop). Inside the loop executor, call `execBody(node.data.body, itemCtx, `#${index}`)`. In `execBody`, when checking the resume short-circuit and when writing `ctx.step`/emitting, use `id + indexKey` as the persisted/looked-up nodeId. Skip an entire iteration when every body id has a `completed[`${id}#${index}`]`. Keep the main-chain path (indexKey='') byte-identical in behavior to today.

- [ ] **Step 4: Implement per-iteration persistence in the executor**

In `execute-flow.ts`, where step rows are written and where `completed` is built: persist the interpreter's emitted per-iteration nodeId (`${id}#${index}`) verbatim to `FlowRunStep.nodeId`, and build `completed` keyed by that exact nodeId. The existing main-chain keying (no suffix) is unchanged. Confirm the resume path reads these `#index` keys back into `opts.completed`.

- [ ] **Step 5: Per-iteration approval matching**

In `approval-decision.ts`, `shouldConsumeApprovalDecision` currently matches a replied decision against the set of paused ids. Tighten it so a decision made for iteration i's node (`${nodeId}#${i}`) is consumed only by that iteration on resume — not by iteration 0 when the loop re-enters. Add a focused unit test.

- [ ] **Step 6: DB resume test**

Extend `execute-flow-resume.test.ts` (throwaway pgvector DB): seed a flow with a loop whose body pauses on iteration 1; run to `waiting`; assert the persisted `FlowRunStep` rows include `body#0` (succeeded) and the iteration-1 waiting row; reply; assert on resume no NEW `body#0` row is created (item 0 not re-run) and the run completes with all three items.

- [ ] **Step 7: Full gate + commit**

`npm run typecheck && npm run lint && npm test` + the DB suite against a throwaway pgvector DB.

```bash
git add src/features/flows/interpret.ts src/features/flows/execute-flow.ts src/lib/flows/approval-decision.ts src/features/flows/__tests__/interpret.test.ts src/features/flows/__tests__/execute-flow-resume.test.ts
git commit -m "fix(flows): loops resume from their cursor — a mid-loop pause no longer re-runs prior iterations' side effects"
```

---

### Task 5: Docs, CI-mode gate, push, final review

- [ ] **Step 1: Roadmap + ARCHITECTURE.md** — mark #1 (condition-in-container validation), #3 (trigger disambiguation), #4 (trigger filter), #2 (loop resume-cursor) in `docs/superpowers/plans/2026-07-07-flows-workato-parity-roadmap.md`; note the remaining big bets (formula mode, try-catch, sub-flows, polling triggers, lookup tables, full branch-in-container). One sentence in ARCHITECTURE.md's Flow Execution section on per-iteration resume keying.
- [ ] **Step 2: Isolated-worktree gate** — worktree at HEAD, symlink node_modules; typecheck/lint/test; recreate `ci_repro` with `CREATE EXTENSION vector`, `migrate deploy`, DB-backed `npm test`, `npm run build`.
- [ ] **Step 3: Push + CI green.**
- [ ] **Step 4: Final whole-workstream review** (most capable model) — focus the review on Task 4's correctness (no duplicate side effects on resume; main-chain behavior unchanged) and the trigger-filter entry-point wiring.
