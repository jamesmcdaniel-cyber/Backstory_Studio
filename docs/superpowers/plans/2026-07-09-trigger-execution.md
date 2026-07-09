# WS4: Trigger Execution Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 4 of `docs/superpowers/specs/2026-07-08-flow-parity-design.md` — every trigger type genuinely fires. Discovery at planning time: flow **schedule dispatch already exists** in `/api/cron/dispatch` (catch-up `isDue` over `flow.trigger.schedule`, published-only, 15-min tick), so the schedule half is hardening + UI honesty; the **signals system is built from scratch**.

**Architecture:** Schedule: add a pure `nextOccurrence()` to the existing `src/lib/scheduling/due.ts` (powers "Next run" UI), an overlap guard + per-tick flow cap in the cron dispatcher. Signals: a pure-matching service (`src/features/flows/signals.ts`) with a depth-capped, self-excluding `emitFlowSignal`, an authed `POST /api/flows/signals/[name]` endpoint, and two built-in emit points (flow completed, agent completed). UI: the drawer's trigger editor learns `signal`, trigger cards state their live behavior ("Next run …", "Listens for …").

**Tech Stack:** Existing Intl-based scheduling lib (no new deps — its 5-field cron matcher is reused for forward scanning), Prisma, `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent. Baseline 361 pass / 6 skip; 4 pre-existing lint warnings. Never run dev/build/prisma-migrate; no schema changes in this workstream.
- Exact values: signal names for built-in emit points `flow.completed` and `agent.completed`; signal chain-depth cap `3` (a signal-triggered flow's own emissions carry `depth+1`; emissions at depth ≥ 3 are dropped); flows-per-tick cap `10`; run overlap = latest run status `running` or `waiting` → skip + log, never double-fire.
- Signal trigger config lives on the trigger JSON: `{ type: 'signal', signal: '<name>' }` (name free-text, datalist suggests the two built-ins). Signal-triggered runs record `trigger: { type: 'signal', signal, depth }` on the FlowRun.
- Payload contract: the emit payload becomes the flow's run input verbatim (spec's "optional input field mapping" is deferred — document in the drawer helper text that the payload arrives as `{{trigger.input}}`).
- `FlowExecutionJob.trigger` union gains `'signal'`; nothing else in `runFlowExecution` changes.
- The cron dispatcher's fail-closed CRON_SECRET auth and existing agent-dispatch behavior are untouched.

---

### Task 1: nextOccurrence in the scheduling lib

**Files:**
- Modify: `src/lib/scheduling/due.ts`
- Test: `src/lib/scheduling/__tests__/due.test.ts` (append)

**Interfaces:**
- Produces: `nextOccurrence(schedule: AgentSchedule, from: Date): Date | null` — the next UTC instant the schedule fires strictly after `from`; `null` for `manual`, inactive (`isActive === false`), or a `once` whose instant has passed. MUST mirror `isDue`'s semantics per type (READ `isDue` first): hourly (its minute convention), daily (time-of-day in `timezone`), weekly (its day-of-week convention — mirror exactly whatever `isDue` uses), once (`runAt` + `time`), cron (reuse the file's existing 5-field matcher by scanning forward minute-by-minute from `from`, cap the scan at 370 days → null beyond).

- [ ] **Step 1: Failing tests**

Append to `src/lib/scheduling/__tests__/due.test.ts` (reuse its existing schedule fixtures/helpers; adjust construction to the file's style):

```ts
test('nextOccurrence: daily returns today’s instant when still ahead, else tomorrow’s', () => {
  const schedule = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
  const before = nextOccurrence(schedule, new Date('2026-07-09T05:00:00Z'))
  assert.equal(before?.toISOString(), '2026-07-09T09:00:00.000Z')
  const after = nextOccurrence(schedule, new Date('2026-07-09T10:00:00Z'))
  assert.equal(after?.toISOString(), '2026-07-10T09:00:00.000Z')
})

test('nextOccurrence: respects timezone wall-clock', () => {
  const schedule = { type: 'daily', time: '09:00', cron: '', timezone: 'America/New_York', isActive: true } as AgentSchedule
  const next = nextOccurrence(schedule, new Date('2026-07-09T05:00:00Z')) // 01:00 NY
  assert.equal(next?.toISOString(), '2026-07-09T13:00:00.000Z') // 09:00 EDT = 13:00Z
})

test('nextOccurrence: once in the future fires once, in the past returns null', () => {
  const future = { type: 'once', time: '12:00', cron: '', timezone: 'UTC', runAt: '2026-07-10', isActive: true } as AgentSchedule
  assert.equal(nextOccurrence(future, new Date('2026-07-09T00:00:00Z'))?.toISOString(), '2026-07-10T12:00:00.000Z')
  assert.equal(nextOccurrence(future, new Date('2026-07-11T00:00:00Z')), null)
})

test('nextOccurrence: cron scans forward with the existing matcher', () => {
  const schedule = { type: 'cron', time: '', cron: '30 14 * * 1', timezone: 'UTC', isActive: true } as AgentSchedule
  const next = nextOccurrence(schedule, new Date('2026-07-09T00:00:00Z')) // Thursday
  assert.equal(next?.toISOString(), '2026-07-13T14:30:00.000Z') // next Monday 14:30
})

test('nextOccurrence: manual and inactive return null', () => {
  assert.equal(nextOccurrence({ type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule, new Date()), null)
  assert.equal(nextOccurrence({ type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: false } as AgentSchedule, new Date()), null)
})
```

Add an `hourly` expectation mirroring whatever convention `isDue` implements (read it, then assert that exact minute).

- [ ] **Step 2: RED**, implement (reusing `zoneParts`/`instantForDate`/`todayInstant` and the cron matcher already in the file; for cron scan minute-by-minute from `from + 1min`, evaluating the matcher against the ZONED wall clock exactly as `isDue` does, capped at 370 days), **GREEN**, full suite.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scheduling/due.ts src/lib/scheduling/__tests__/due.test.ts
git commit -m "feat(scheduling): nextOccurrence — forward schedule computation"
```

---

### Task 2: Dispatcher hardening + signal trigger type

**Files:**
- Modify: `src/app/api/cron/dispatch/route.ts` (flow section only)
- Modify: `src/features/flows/execute-flow.ts` (trigger union)

**Interfaces:**
- Produces: flow dispatch skips overlapping runs and caps at 10/tick; `FlowExecutionJob['trigger']` becomes `{ type: 'manual' | 'schedule' | 'webhook' | 'signal'; [key: string]: unknown }`.

- [ ] **Step 1: Overlap guard + cap**

In the dispatcher's flow section: change the runs include to also select `status`; add `const MAX_FLOWS_PER_TICK = 10` and a counter; inside the loop, after the `isDue` check:

```ts
        // Overlap guard: a still-active previous run means skip this tick —
        // a slow flow must never stack concurrent scheduled executions.
        const lastRun = flow.runs[0]
        if (lastRun && (lastRun.status === 'running' || lastRun.status === 'waiting')) {
          apiLogger.warn('cron/dispatch: flow run still active, skipping tick', { flowId: flow.id })
          continue
        }
        if (ranFlowIds.length >= MAX_FLOWS_PER_TICK) break
```

(the include becomes `select: { startedAt: true, status: true }`).

- [ ] **Step 2: Trigger union** — in `execute-flow.ts` line ~31 add `'signal'` to the trigger type union. Nothing else.

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/app/api/cron/dispatch/route.ts src/features/flows/execute-flow.ts
git commit -m "feat(flows): schedule dispatch overlap guard, per-tick cap, signal trigger type"
```

---

### Task 3: Signals — service, endpoint, emit points

**Files:**
- Create: `src/features/flows/signals.ts`
- Create: `src/app/api/flows/signals/[name]/route.ts`
- Modify: `src/features/flows/execute-flow.ts` (emit `flow.completed`)
- Modify: `src/features/agents/execute-agent.ts` (emit `agent.completed`)
- Test: `src/features/flows/__tests__/signals.test.ts`

**Interfaces:**
- Produces:
  - `SIGNAL_DEPTH_CAP = 3`, `KNOWN_SIGNALS = ['flow.completed', 'agent.completed'] as const`
  - `flowListensTo(flow: { trigger: unknown; publishedGraph: unknown; status: string }, signal: string): boolean` — pure: ACTIVE + published + `trigger.type === 'signal'` + `trigger.signal === signal`
  - `signalDepthOf(trigger: unknown): number` — pure: reads `depth` from a run trigger, 0 default
  - `emitFlowSignal(params: { organizationId: string; signal: string; payload: unknown; sourceFlowId?: string; depth?: number }): Promise<{ matched: number }>` — depth ≥ cap → `{ matched: 0 }` (logged); loads up to 200 ACTIVE org flows, filters via `flowListensTo`, excludes `sourceFlowId`, attributes each run to the flow owner (or oldest active org member — mirror the cron dispatcher's owner lookup), fires `runFlowExecution({ usePublished: true, input: payload, trigger: { type: 'signal', signal, depth } })` per match with per-flow try/catch (one failure never blocks others); awaited sequentially (callers fire-and-forget the whole emit)

- [ ] **Step 1: Failing tests** (`src/features/flows/__tests__/signals.test.ts`)

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowListensTo, signalDepthOf, SIGNAL_DEPTH_CAP } from '../signals'

const listening = { status: 'ACTIVE', publishedGraph: { nodes: [] }, trigger: { type: 'signal', signal: 'flow.completed' } }

test('flowListensTo matches only active, published, name-matched signal flows', () => {
  assert.equal(flowListensTo(listening, 'flow.completed'), true)
  assert.equal(flowListensTo({ ...listening, trigger: { type: 'signal', signal: 'other' } }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, status: 'DRAFT' }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, publishedGraph: null }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, trigger: { type: 'webhook' } }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, trigger: 'garbage' }, 'flow.completed'), false)
})

test('signalDepthOf reads run-trigger depth with a 0 default and the cap is 3', () => {
  assert.equal(signalDepthOf({ type: 'signal', signal: 'x', depth: 2 }), 2)
  assert.equal(signalDepthOf({ type: 'manual' }), 0)
  assert.equal(signalDepthOf(null), 0)
  assert.equal(SIGNAL_DEPTH_CAP, 3)
})
```

- [ ] **Step 2: RED → implement `signals.ts`** (pure helpers exactly per Interfaces; `emitFlowSignal` mirrors the cron dispatcher's owner-attribution snippet; `apiLogger.warn` on depth drop and per-flow failure). GREEN + full suite.

- [ ] **Step 3: Endpoint** — `src/app/api/flows/signals/[name]/route.ts`: `withAuthenticatedApi` POST; `name = decodeURIComponent(request.nextUrl.pathname.split('/').at(-1) ?? '')`, 400 when blank or > 100 chars; body JSON (any, default `{}`) is the payload; `const result = await emitFlowSignal({ organizationId: auth.organizationId, signal: name, payload })`; return `{ success: true, matched: result.matched }`.

- [ ] **Step 4: Emit points**

- `execute-flow.ts`: in `runFlowExecution` right after the final run update when `status === 'succeeded'` (NOT waiting/failed), fire-and-forget:

```ts
  if (status === 'succeeded') {
    void import('./signals')
      .then((signals) =>
        signals.emitFlowSignal({
          organizationId: job.organizationId,
          signal: 'flow.completed',
          payload: { flowId: flow.id, flowName: flow.name, output: result.output },
          sourceFlowId: flow.id,
          depth: signals.signalDepthOf(job.trigger) + 1,
        }),
      )
      .catch(() => undefined)
  }
```

(dynamic import avoids a static cycle since signals.ts imports runFlowExecution — VERIFY the cycle direction and, if `signals.ts`'s import of `runFlowExecution` already creates no cycle issue with a static import here, prefer static; report which.)

- `execute-agent.ts`: in the completion block (next to the existing `indexExecution`/`reflectAndRemember` fire-and-forgets):

```ts
    void import('@/features/flows/signals')
      .then((signals) =>
        signals.emitFlowSignal({
          organizationId,
          signal: 'agent.completed',
          payload: { agentId: agent.id, executionId: execution.id, summary: summary.slice(0, 2000) },
          depth: 1,
        }),
      )
      .catch(() => undefined)
```

- [ ] **Step 5: Verify + commit**

`npx tsx --test src/features/flows/__tests__/signals.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/features/flows/signals.ts 'src/app/api/flows/signals/[name]/route.ts' src/features/flows/execute-flow.ts src/features/agents/execute-agent.ts src/features/flows/__tests__/signals.test.ts
git commit -m "feat(flows): signal triggers — emit service, endpoint, flow/agent completion signals"
```

---

### Task 4: Trigger UI honesty

**Files:**
- Modify: `src/components/flows/step-drawer.tsx` (TriggerEditor: signal option + config)
- Modify: `src/components/flows/flow-canvas.tsx` (`titleFor`/`subtitleFor` trigger cases)

**Interfaces:**
- Consumes: `nextOccurrence` (Task 1), `KNOWN_SIGNALS` (Task 3 — import the CONST only; it's dependency-light? NO — signals.ts imports prisma. Put the const in a shared spot instead: move `KNOWN_SIGNALS` to `src/lib/flows/trigger.ts` and re-export from signals.ts so the client bundle never pulls prisma. Task 3's implementer defines it in trigger.ts from the start; this task imports from `@/lib/flows/trigger`).

- [ ] **Step 1: Drawer**

In `TriggerEditor` (`step-drawer.tsx`):
- Trigger type `<select>` gains `<option value="signal">Signal (in-platform event)</option>`; `TriggerData.type` union gains `'signal'`.
- When `type === 'signal'`: a `Signal name` input bound to `trigger.signal` (string) with a `<datalist>` of `KNOWN_SIGNALS`, helper text: `Fires when this signal is emitted anywhere in your workspace. The signal payload arrives as {{trigger.input}}. Runs the published version.`
- When `type === 'schedule'`: under the existing schedule fields add a live preview line: `Next run: <formatted>` computed via `nextOccurrence({ ...schedule defaults merged, isActive: true } as AgentSchedule, new Date())` — `toLocaleString()` result, or `Not scheduled` when null. Import from `@/lib/scheduling/due` (pure, client-safe).

- [ ] **Step 2: Canvas cards**

`flow-canvas.tsx`:
- `titleFor` trigger case: add `if (type === 'signal') return 'Signal trigger'`.
- `subtitleFor` trigger case: schedule → `Runs ${schedule.type}${schedule.time ? ` at ${schedule.time}` : ''} (${schedule.timezone || 'UTC'})`; webhook → keep existing; signal → `Listens for "${trigger.signal || 'unnamed signal'}"`; manual → existing input-count line. (Read the current `subtitleFor` — extend, don't restructure.)

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/step-drawer.tsx src/components/flows/flow-canvas.tsx
git commit -m "feat(flows): signal trigger config + honest schedule/signal trigger cards"
```

---

### Task 5: Final verification

- [ ] `npm run typecheck && npm run lint && npm test` — all green.
Spec deviation (documented): spec §4's `nextRunAt` indexed column + per-run recompute is unnecessary — the pre-existing dispatcher uses catch-up `isDue(schedule, lastRunStartedAt, now)` semantics (no arming state to persist, no drift), so no schema change ships; `nextOccurrence` covers the spec's "Next run:" display requirement instead.

- [ ] Reasoning smoke checklist: scheduled published flow fires on the next due tick exactly once (overlap-guarded, capped); signal endpoint fires matching published flows only, excluding the source flow, depth-capped at 3; flow completion chains flows; agent completion triggers listening flows; drawer configures signal + shows next-run preview; cards state live behavior; DRAFT flows never fire (published-only checks in dispatcher + flowListensTo).
