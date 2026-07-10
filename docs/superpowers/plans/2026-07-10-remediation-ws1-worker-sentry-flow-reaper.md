# Remediation WS-R1: Worker Sentry Init + Flow Reaper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make worker-process failures visible in Sentry, and stop crashed flow runs from sitting `running` forever and wedging their schedules.

**Architecture:** Three small, independent seams. (1) The standalone Fastify worker (`src/lib/workers/runtime.ts`) initializes the existing `initSentry()` reporter at boot, captures process-level failures, and flushes on shutdown — the `captureError` seam already used by dead-letter and the rest of the server then reports from the worker too. (2) A new `src/lib/flows/reap.ts` fails FlowRuns stuck `running` past 30 minutes (and their live steps), called from the cron dispatch tick exactly like the existing agent-execution reaper. (3) The scheduled-flow overlap guard stops treating a `waiting` run older than 24h as blocking, via a pure helper in the same file.

**Tech Stack:** TypeScript, Prisma, node:test (`tsx --test`), @sentry/nextjs (dynamic import), Vercel cron dispatch route.

**Supersession note:** This plan implements the *reaper* behavior of WS9 Task 5 (`docs/superpowers/plans/2026-07-10-flow-execution-parity.md`). The *timeout-race* behavior of WS9 Task 5 is NOT covered here — it moves to Remediation WS-R2 (flow durability parity). The WS9 plan file is annotated accordingly.

**Task 3 status: SKIPPED (2026-07-10).** During execution, a concurrent Claude Code session was found already implementing the stale-waiting-scheduling behavior directly in WS9 (as `src/lib/flows/schedule-blocking.ts` / `blocksSchedule`, wired into the same cron dispatch route this plan's Task 2 also touches). To avoid two competing implementations landing in the same file, the user chose to drop Task 3 from this workstream and let WS9 own that behavior end-to-end. Task 3's steps below are retained for the record but were not executed; do not implement them if this plan is ever resumed — check WS9's status first.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent (match surrounding files exactly).
- Never run `next dev` or `prisma migrate` against real env locally; the verification gate is `npm run typecheck && npm run lint && npm test`. Before push, reproduce CI mode: recreate the throwaway local Postgres DB `ci_repro`, `prisma migrate deploy` into it, and run `npm test` with `TEST_DATABASE_URL` set (see Task 4 for exact commands).
- DB-backed tests must self-skip when `TEST_DATABASE_URL` is unset (follow the `src/lib/agents/__tests__/approval.test.ts` gating pattern) so `npm test` stays green on dev machines.
- No schema changes in this workstream. No new dependencies.
- Observability code must never take the process down: init/flush/report failures degrade to `console` output.
- Commits go directly to `main`. Do not push until the Task 4 gate.

---

### Task 1: Sentry in the worker runtime

**Files:**
- Modify: `src/lib/observability/sentry.ts`
- Modify: `src/lib/workers/runtime.ts`
- Test: `src/lib/observability/__tests__/sentry.test.ts` (extend existing)

**Interfaces:**
- Consumes: existing `captureError` / `setErrorReporter` / `resetErrorReporter` seams.
- Produces: `initSentry(processTag?: string): Promise<void>` (now failure-proof, tags events with `process: web|worker`), `flushErrorReporting(timeoutMs?: number): Promise<void>`, and test seam `setErrorFlusher(fn: (timeoutMs: number) => Promise<void>): void`. `resetErrorReporter()` now also resets the flusher. Task 2/3 do not depend on this task.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/observability/__tests__/sentry.test.ts`:

```ts
import { flushErrorReporting, setErrorFlusher } from '../sentry'

test('flushErrorReporting is a safe no-op when Sentry was never initialized', async () => {
  await assert.doesNotReject(() => flushErrorReporting())
})

test('flushErrorReporting forwards the timeout to an injected flusher', async () => {
  const calls: number[] = []
  setErrorFlusher(async (timeoutMs) => {
    calls.push(timeoutMs)
  })
  await flushErrorReporting(1234)
  assert.deepEqual(calls, [1234])
})

test('a rejecting flusher never breaks the caller', async () => {
  setErrorFlusher(async () => {
    throw new Error('flush exploded')
  })
  await assert.doesNotReject(() => flushErrorReporting())
})
```

Note: the existing file already imports `test, beforeEach` and `assert`; merge the new imports into the existing import line from `'../sentry'`. `beforeEach(() => resetErrorReporter())` at the top of the file must reset the flusher too (that behavior is added in Step 3) — the injected-flusher test relies on it not leaking into the no-op test, so keep test order as written above.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx tsx --test src/lib/observability/__tests__/sentry.test.ts`
Expected: FAIL — `flushErrorReporting` / `setErrorFlusher` are not exported.

- [ ] **Step 3: Implement the sentry.ts changes**

Replace the bottom half of `src/lib/observability/sentry.ts` (keep the header comment, `ErrorReporter` type, `reporter` variable, `setErrorReporter`, `captureError` as-is):

```ts
type ErrorFlusher = (timeoutMs: number) => Promise<void>

let flusher: ErrorFlusher | null = null

/** Test seam: inject a flusher the way setErrorReporter injects a reporter. */
export function setErrorFlusher(next: ErrorFlusher): void {
  flusher = next
}

export function resetErrorReporter(): void {
  reporter = null
  flusher = null
}

/**
 * Drain any queued error reports (Sentry buffers sends). Call before a
 * deliberate process exit — without it, the last errors of a worker's life
 * are exactly the ones that get dropped. Safe no-op when never initialized.
 */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!flusher) return
  try {
    await flusher(timeoutMs)
  } catch {
    // Flushing is best-effort; never take shutdown down with it.
  }
}

/**
 * Initialize Sentry server-side and route captureError through it.
 * `processTag` distinguishes web (Next.js) from the standalone worker in the
 * Sentry UI. Never throws: an observability failure must not stop the process.
 */
export async function initSentry(processTag = 'web'): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
    })
    Sentry.setTag('process', processTag)
    setErrorReporter((error, context) => {
      Sentry.captureException(error, context ? { extra: context } : undefined)
    })
    setErrorFlusher(async (timeoutMs) => {
      await Sentry.flush(timeoutMs)
    })
  } catch (error) {
    console.error('[sentry] init failed; falling back to console reporting', error)
  }
}
```

Note `resetErrorReporter` is redefined to clear both seams — delete the old two-line version. `instrumentation.ts` calls `initSentry()` with no argument, so the web path keeps working with `process: web` unchanged behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/observability/__tests__/sentry.test.ts`
Expected: PASS (all, including the three pre-existing tests).

- [ ] **Step 5: Wire the worker runtime**

Modify `src/lib/workers/runtime.ts`:

Add to imports:

```ts
import { initSentry, captureError, flushErrorReporting } from '@/lib/observability/sentry'
```

In `setupShutdown()`, flush before exit:

```ts
  private setupShutdown() {
    const shutdown = async () => {
      if (this.scheduleTimer) clearInterval(this.scheduleTimer)
      await this.server.close()
      await Promise.all(this.workers.map((worker) => worker.close()))
      await flushErrorReporting()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
```

In `start()`, initialize Sentry first and capture process-level failures (the worker is where long runs die; without these hooks a crash is invisible):

```ts
  async start(port = 3002) {
    await initSentry('worker')
    process.on('unhandledRejection', (reason) => {
      captureError(reason, { source: 'worker.unhandledRejection' })
    })
    process.on('uncaughtException', (error) => {
      captureError(error, { source: 'worker.uncaughtException' })
      void flushErrorReporting().finally(() => process.exit(1))
    })
    await registerAgentSchedules()
    this.scheduleTimer = setInterval(() => {
      registerAgentSchedules().catch((error) => this.server.log.error(error, 'Schedule reconciliation failed'))
    }, 60_000)
    await this.server.listen({ port, host: '0.0.0.0' })
  }
```

And make the main-entry catch report before dying:

```ts
if (require.main === module) {
  new WorkerRuntime().start(Number(process.env.WORKER_PORT) || 3002).catch(async (error) => {
    console.error(error)
    captureError(error, { source: 'worker.start' })
    await flushErrorReporting()
    process.exit(1)
  })
}
```

- [ ] **Step 6: Run the full verification gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint 0 errors, all tests pass (baseline ~397 pass / DB-backed skip locally).

- [ ] **Step 7: Commit**

```bash
git add src/lib/observability/sentry.ts src/lib/observability/__tests__/sentry.test.ts src/lib/workers/runtime.ts
git commit -m "feat(observability): worker process reports to Sentry — init at boot, crash hooks, flush on shutdown"
```

---

### Task 2: Flow run reaper

**Files:**
- Create: `src/lib/flows/reap.ts`
- Modify: `src/app/api/cron/dispatch/route.ts` (after the agent reaper block, ~line 86)
- Test: `src/lib/flows/__tests__/reap.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/prisma`; `FlowRun`/`FlowRunStep` models (statuses: run `running | succeeded | failed | waiting`; step `queued | running | succeeded | failed | skipped | waiting`; run uses `finishedAt`, NOT `completedAt`).
- Produces: `reapStuckFlowRuns(now?: Date): Promise<number>` and constant `STUCK_FLOW_RUN_TIMEOUT_MS` (30 min: the dispatch route's `maxDuration` is 1200s; 30 min = budget + slack, per WS9 Task 5 spec). Task 3 adds `lastRunBlocksSchedule` to this same file.

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/reap.test.ts`. Pure-import assertion runs everywhere; DB behavior is gated exactly like `approval.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

test('stuck-run cutoff is 30 minutes', async () => {
  const { STUCK_FLOW_RUN_TIMEOUT_MS } = await import('../reap')
  assert.equal(STUCK_FLOW_RUN_TIMEOUT_MS, 30 * 60 * 1000)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let reapStuckFlowRuns: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ reapStuckFlowRuns } = await import('../reap'))
    const org = await prisma.organization.create({ data: { name: 'Reap', slug: `reap-${Date.now()}` } })
    ids.org = org.id
    const flow = await prisma.flow.create({
      data: { name: 'reap-target', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const fresh = new Date(Date.now() - 5 * 60 * 1000)
    ids.staleRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: stale },
      })
    ).id
    ids.staleStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n1', status: 'running', startedAt: stale },
      })
    ).id
    ids.staleDoneStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n0', status: 'succeeded', startedAt: stale },
      })
    ).id
    ids.freshRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: fresh },
      })
    ).id
    ids.staleWaiting = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'waiting', startedAt: stale },
      })
    ).id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('reapStuckFlowRuns fails only stale running runs and their live steps', async () => {
    const reaped = await reapStuckFlowRuns()
    assert.equal(reaped, 1)

    const staleRun = await prisma.flowRun.findUnique({ where: { id: ids.staleRunning } })
    assert.equal(staleRun.status, 'failed')
    assert.equal(staleRun.error, 'The run was interrupted and timed out.')
    assert.ok(staleRun.finishedAt)

    const staleStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleStep } })
    assert.equal(staleStep.status, 'failed')

    const doneStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleDoneStep } })
    assert.equal(doneStep.status, 'succeeded')

    const freshRun = await prisma.flowRun.findUnique({ where: { id: ids.freshRunning } })
    assert.equal(freshRun.status, 'running')

    const waitingRun = await prisma.flowRun.findUnique({ where: { id: ids.staleWaiting } })
    assert.equal(waitingRun.status, 'waiting')
  })

  test('reapStuckFlowRuns is idempotent — second pass reaps nothing', async () => {
    assert.equal(await reapStuckFlowRuns(), 0)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/flows/__tests__/reap.test.ts`
Expected: FAIL — `Cannot find module '../reap'` (the pure cutoff test fails on import; DB tests skip without `TEST_DATABASE_URL`).

- [ ] **Step 3: Implement the reaper**

Create `src/lib/flows/reap.ts`:

```ts
/**
 * Stuck flow-run recovery. Flows execute inline in serverless/dispatcher
 * processes (no BullMQ job wraps them yet), so a recycled process orphans the
 * FlowRun as `running` forever — and the scheduled-flow overlap guard then
 * skips every future tick for that flow. The cron dispatch tick calls
 * reapStuckFlowRuns() to fail anything running past the budget, mirroring the
 * agent-execution reaper.
 */

import { prisma } from '@/lib/prisma'

// Dispatch/execute routes cap at maxDuration 1200s; 30 min = budget + slack.
export const STUCK_FLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000

const STUCK_RUN_ERROR = 'The run was interrupted and timed out.'
const REAP_BATCH_LIMIT = 500

/** Fail runs stuck `running` past the cutoff (and their still-live steps). Returns the reaped count. */
export async function reapStuckFlowRuns(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_FLOW_RUN_TIMEOUT_MS)
  const stuck = await prisma.flowRun.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    select: { id: true },
    take: REAP_BATCH_LIMIT,
  })
  if (stuck.length === 0) return 0
  const runIds = stuck.map((run) => run.id)
  // Status re-checked in the updateMany so a run that legitimately finished
  // between the read and the write is left alone.
  const [reaped] = await prisma.$transaction([
    prisma.flowRun.updateMany({
      where: { id: { in: runIds }, status: 'running' },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    }),
    prisma.flowRunStep.updateMany({
      where: { flowRunId: { in: runIds }, status: { in: ['queued', 'running', 'waiting'] } },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    }),
  ])
  return reaped.count
}
```

- [ ] **Step 4: Run test to verify the pure part passes**

Run: `npx tsx --test src/lib/flows/__tests__/reap.test.ts`
Expected: PASS (cutoff test; DB tests skip locally). The DB-backed assertions run at the Task 4 ci_repro gate.

- [ ] **Step 5: Wire into the cron dispatch tick**

In `src/app/api/cron/dispatch/route.ts`, add to imports:

```ts
import { reapStuckFlowRuns } from '@/lib/flows/reap'
import { captureError } from '@/lib/observability/sentry'
```

Directly after the existing agent-execution reaper `updateMany` block (after line 86), add:

```ts
    // Same recovery for flows: a crashed inline flow execution leaves its run
    // `running` forever, which also wedges that flow's schedule via the
    // overlap guard. Isolated so a reaper failure never aborts the tick.
    try {
      await reapStuckFlowRuns()
    } catch (error) {
      apiLogger.error('cron/dispatch: flow reaper failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.flowReaper' })
    }
```

- [ ] **Step 6: Run the full verification gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/reap.ts src/lib/flows/__tests__/reap.test.ts src/app/api/cron/dispatch/route.ts
git commit -m "fix(flows): stuck running runs reaped after 30 min — crashed flows no longer wedge their schedules"
```

---

### Task 3: Stale-waiting runs stop blocking schedules

**Files:**
- Modify: `src/lib/flows/reap.ts` (add pure helper)
- Modify: `src/app/api/cron/dispatch/route.ts` (~lines 233-239, the overlap guard)
- Test: `src/lib/flows/__tests__/reap.test.ts` (extend, pure tests — no DB)

**Interfaces:**
- Consumes: nothing new.
- Produces: `lastRunBlocksSchedule(lastRun: { status: string; startedAt: Date } | null | undefined, now?: Date): boolean` and constant `STALE_WAITING_BLOCK_MS` (24h), exported from `src/lib/flows/reap.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/flows/__tests__/reap.test.ts` (top-level, NOT inside the `if (TEST_DB)` block — these are pure):

```ts
test('lastRunBlocksSchedule: running always blocks; waiting blocks only for 24h', async () => {
  const { lastRunBlocksSchedule, STALE_WAITING_BLOCK_MS } = await import('../reap')
  const now = new Date('2026-07-10T12:00:00Z')
  const recent = new Date(now.getTime() - 60 * 60 * 1000)
  const stale = new Date(now.getTime() - STALE_WAITING_BLOCK_MS - 1)

  assert.equal(lastRunBlocksSchedule(undefined, now), false)
  assert.equal(lastRunBlocksSchedule(null, now), false)
  assert.equal(lastRunBlocksSchedule({ status: 'running', startedAt: recent }, now), true)
  assert.equal(lastRunBlocksSchedule({ status: 'running', startedAt: stale }, now), true)
  assert.equal(lastRunBlocksSchedule({ status: 'waiting', startedAt: recent }, now), true)
  assert.equal(lastRunBlocksSchedule({ status: 'waiting', startedAt: stale }, now), false)
  assert.equal(lastRunBlocksSchedule({ status: 'succeeded', startedAt: recent }, now), false)
  assert.equal(lastRunBlocksSchedule({ status: 'failed', startedAt: recent }, now), false)
})
```

Rationale for `running`+stale ⇒ still blocks: the reaper (Task 2, same tick, runs first) converts stale running runs to `failed`; a run the reaper deliberately left `running` must keep blocking.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/flows/__tests__/reap.test.ts`
Expected: FAIL — `lastRunBlocksSchedule` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/flows/reap.ts`:

```ts
// A waiting run older than this no longer blocks its flow's schedule — the
// question may simply never be answered, and one ignored ask must not stop
// every future scheduled run. The old run itself stays answerable.
export const STALE_WAITING_BLOCK_MS = 24 * 60 * 60 * 1000

/** Overlap-guard decision for scheduled flows: does the latest run block this tick? */
export function lastRunBlocksSchedule(
  lastRun: { status: string; startedAt: Date } | null | undefined,
  now = new Date(),
): boolean {
  if (!lastRun) return false
  if (lastRun.status === 'running') return true
  if (lastRun.status === 'waiting') {
    return now.getTime() - lastRun.startedAt.getTime() < STALE_WAITING_BLOCK_MS
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/flows/__tests__/reap.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the inline overlap guard**

In `src/app/api/cron/dispatch/route.ts`, extend the reap import:

```ts
import { reapStuckFlowRuns, lastRunBlocksSchedule } from '@/lib/flows/reap'
```

Replace the guard (currently `if (lastRun && (lastRun.status === 'running' || lastRun.status === 'waiting')) { ... continue }`) with:

```ts
        // Overlap guard: a still-active previous run means skip this tick —
        // a slow flow must never stack concurrent scheduled executions. A
        // waiting run only blocks for 24h (lastRunBlocksSchedule); after that
        // the schedule proceeds and the old run stays answerable.
        const lastRun = flow.runs[0]
        if (lastRunBlocksSchedule(lastRun, now)) {
          apiLogger.warn('cron/dispatch: flow run still active, skipping tick', { flowId: flow.id })
          continue
        }
```

- [ ] **Step 6: Run the full verification gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/reap.ts src/lib/flows/__tests__/reap.test.ts src/app/api/cron/dispatch/route.ts
git commit -m "fix(flows): waiting runs older than 24h stop blocking their schedule"
```

---

### Task 4: Docs, CI-mode gate, push

**Files:**
- Modify: `docs/superpowers/plans/2026-07-10-flow-execution-parity.md` (WS9 Task 5 supersession note)
- Modify: `ARCHITECTURE.md` (worker Sentry note in Runtime Boundary section)
- Modify: `.superpowers/sdd/progress.md` (ledger)

**Interfaces:** none — documentation and verification only.

- [x] **Step 1: Annotate WS9 Task 5** — done ahead of this step, corrected for the Task 3 skip: the WS9 plan file's Task 5 now notes only the *reaper* was superseded by WS-R1; *timeout race* and *stale-waiting scheduling* remain WS9's own scope (the latter already in flight in the concurrent session as `schedule-blocking.ts`).

- [ ] **Step 2: Update ARCHITECTURE.md**

In the `## Runtime Boundary` section, after the sentence describing the worker (item 2), append a sentence to that paragraph:

```markdown
Both runtimes report errors through `src/lib/observability/sentry.ts`; the worker initializes it at boot (tagged `process: worker`) and flushes on shutdown.
```

- [ ] **Step 3: Append to the ledger**

Append to `.superpowers/sdd/progress.md`:

```
=== REMEDIATION WS-R1 worker sentry + flow reaper ===
(absorbs WS9 Task 5 reaper + stale-waiting; WS9 Task 5 timeout-race moves to WS-R2)
```

plus one line per completed task with commit hashes and review outcomes (filled during execution).

- [ ] **Step 4: Full local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 5: CI-mode gate (DB-backed tests + build)**

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ci_repro' -c 'CREATE DATABASE ci_repro'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm test
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm run build
```

Expected: DB-backed tests (including the new reap tests) un-skip and pass; build succeeds.

- [ ] **Step 6: Commit docs + push**

```bash
git add docs/superpowers/plans/2026-07-10-flow-execution-parity.md ARCHITECTURE.md .superpowers/sdd/progress.md
git commit -m "docs: WS-R1 ledger + WS9 Task 5 supersession note + worker Sentry in architecture doc"
git push origin main
```

- [ ] **Step 7: Confirm CI green**

Run: `curl -s "https://api.github.com/repos/jamesmcdaniel-cyber/Backstory_Studio/actions/runs?per_page=1"` and check `status`/`conclusion` for the pushed SHA (poll until complete).
Expected: `"conclusion": "success"`.
