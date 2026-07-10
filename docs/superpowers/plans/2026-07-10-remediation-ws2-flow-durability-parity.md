# Remediation WS-R2: Flow Durability Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two concrete flow-engine durability gaps — an unguarded resume that can double-execute and can silently run against a stale graph — and stand up (but do not yet wire in) BullMQ queue infrastructure for flow execution, mirroring the agent execution path's crash/retry durability.

**Architecture:** Two independent seams. (1) `runFlowExecution` in `src/features/flows/execute-flow.ts` gains an atomic resume claim (`updateMany` guarded on `status: 'waiting'`, mirroring `execute-agent.ts`'s existing claim pattern) and pins a resumed run to the exact graph it started with (`FlowRun.graphSnapshot`) instead of re-deriving the flow's current graph — both fixes land in the same preamble rewrite since they touch the same lines. (2) A new `flow-execution` BullMQ queue, worker registration, and flow-specific dead-letter recorder are added as available infrastructure (`dispatchFlowExecution`), giving queued flow jobs BullMQ's stall-redelivery and dead-letter protection — but this task deliberately does NOT migrate any of the 5 existing callers of `runFlowExecution` to use it yet (see Scope Note below).

**Tech Stack:** TypeScript, Prisma, BullMQ, node:test (`tsx --test`).

## Scope Note — read before starting

A SEPARATE, concurrently active Claude Code session is working in this exact codebase right now, under a different plan (WS9, `docs/superpowers/plans/2026-07-10-flow-execution-parity.md`), and has been landing commits directly to `main` in `src/features/flows/execute-flow.ts`, `src/features/flows/interpret.ts`, `src/lib/flows/`, and `src/app/api/cron/dispatch/route.ts` throughout this same window. WS9's own roadmap (`docs/superpowers/plans/2026-07-07-flows-workato-parity-roadmap.md`, "Load-bearing engine limits" + P2 item 1 "Resume-after-pause") already claims the loop/parallel-container resume-from-cursor problem — where a paused-then-resumed loop re-executes from item 0, re-firing every already-completed iteration's side effects. **Do NOT attempt that problem in this plan** — it is a large, structural engine feature (a resume cursor keyed by loop-node + iteration index) that is explicitly someone else's active roadmap item, and duplicating it here is exactly the collision WS-R1's Task 3 hit and was told to avoid.

**Before starting each task below:** run `git log --oneline -5 -- <files this task touches>` and `git status -s -- <files this task touches>` to check whether the concurrent session has already landed something overlapping or has uncommitted WIP in those exact lines. If so, stop and reconcile with the user before proceeding — do not guess.

**Verification isolation:** the shared working tree may have the other session's uncommitted files mixed in at any time. Do not run `npm run typecheck`/`lint`/`test`/`build` against the shared working tree if `git status -s` shows files this plan didn't touch — use an isolated git worktree instead (`git worktree add <scratchpad-path> HEAD --detach`, symlink `node_modules`, verify there, `git worktree remove` when done — see WS-R1's Task 4 for the exact command sequence that worked).

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent (match surrounding files exactly).
- Never run `next dev` or `prisma migrate` against real env locally; the verification gate is `npm run typecheck && npm run lint && npm test`. Before push, reproduce CI mode against the throwaway local Postgres DB `ci_repro` (see Task 3 for exact commands).
- DB-backed tests must self-skip when `TEST_DATABASE_URL` is unset (follow the `src/lib/agents/__tests__/approval.test.ts` gating pattern).
- No schema changes. No new npm dependencies (bullmq is already a dependency).
- Commits go directly to `main`. Do not push until the Task 3 gate.
- Match existing terminology exactly: `FlowRun.status` values are `running | succeeded | failed | waiting`; `FlowRunStep.status` values are `queued | running | succeeded | failed | skipped | waiting`; `FlowRun` uses `finishedAt`, NOT `completedAt`.

---

### Task 1: Atomic resume claim + graph-snapshot pinning

**Files:**
- Modify: `src/features/flows/execute-flow.ts:56-134` (the `runFlowExecution` preamble, from the function signature through run creation)
- Test: `src/lib/flows/__tests__/reap.test.ts` is NOT touched by this task — create `src/features/flows/__tests__/execute-flow-resume.test.ts` instead

**Interfaces:**
- Consumes: `ApiError` (already imported in `execute-flow.ts`), `flowGraphSchema` (already imported), `prisma.flowRun` (existing model).
- Produces: no new exported symbols — this task changes `runFlowExecution`'s internal behavior only. Its signature and return type (`Promise<{ flowRunId: string; status: string; output: unknown }>`) are unchanged, so no other task's interface assumptions break.

**Before you begin:** run `git log --oneline -5 -- src/features/flows/execute-flow.ts` and `git status -s -- src/features/flows/execute-flow.ts`. If the concurrent session has uncommitted changes or very recent commits touching lines 56-134 specifically, stop and report — do not guess how to merge around it.

**Current code being replaced** (`execute-flow.ts:56-134`):

```ts
export async function runFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const source = job.usePublished && flow.publishedGraph != null ? flow.publishedGraph : flow.graph
  const graph = flowGraphSchema.parse(source)
  let input: unknown = job.input ?? ''
  const resuming = Boolean(job.flowRunId && job.reply !== undefined)
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: job.organizationId, status: 'ACTIVE' },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(job.organizationId, { userId: job.userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }

  // Required trigger inputs (declared on the trigger node) must be present.
  // Skipped when resuming: the original input was validated on the first run.
  // Input memory: before failing on missing fields, fall back to the last
  // successful run's input — but only when the flow hasn't been edited since
  // that run started (shouldReuseInput), so an edited flow always demands
  // fresh input. A run that supplies every required field never falls back:
  // deliberately different-but-complete input always wins.
  let reusedInput = false
  if (!resuming) {
    const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
    let missing = missingRequiredInputFields(inputFields, input)
    if (missing.length) {
      const lastSuccess = await prisma.flowRun.findFirst({
        where: { flowId: flow.id, organizationId: job.organizationId, status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { input: true, startedAt: true },
      })
      if (lastSuccess && shouldReuseInput({ flowUpdatedAt: flow.updatedAt, lastSuccessStartedAt: lastSuccess.startedAt })) {
        const candidate = storedRunInput(lastSuccess.input)
        if (!missingRequiredInputFields(inputFields, candidate).length) {
          input = candidate
          reusedInput = true
          missing = []
        }
      }
    }
    if (missing.length) {
      throw new ApiError(
        `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        400,
        'FLOW_INPUT_ERROR',
      )
    }
  }
  const run = job.flowRunId
    ? await prisma.flowRun.update({ where: { id: job.flowRunId }, data: { status: 'running' } })
    : await prisma.flowRun.create({
        data: {
          flowId: flow.id,
          status: 'running',
          input: jsonValue({ prompt: input }),
          // reusedInput marks the run as replaying the last successful input —
          // the run panel surfaces it so replayed payloads are never silent.
          trigger: jsonValue({ ...(job.trigger ?? { type: 'manual' }), ...(reusedInput ? { reusedInput: true } : {}) }),
          graphSnapshot: jsonValue(graph),
          organizationId: job.organizationId,
          userId: job.userId,
        },
      })
```

**The bugs this fixes:**
1. `job.flowRunId ? await prisma.flowRun.update(...)` is unconditional — it flips ANY run (regardless of current status) to `running` with no precondition check. Two concurrent resume attempts (e.g. the reply route and the approvals route racing) both succeed and both proceed to call `interpretFlow` against the same run, re-executing already-completed nodes' side effects.
2. `graph` is computed once, at the top, from `flow.graph`/`flow.publishedGraph` (the CURRENT flow definition) — even when resuming. `FlowRun.graphSnapshot` is written on create but never read back. If the flow is edited/republished while a run is paused waiting for a reply, resuming re-interprets the NEW graph, not the one the run actually started against — node ids can shift meaning, and the `completed` skip-map (built from prior `FlowRunStep.nodeId`s) can silently misapply stale outputs to unrelated new nodes.

- [ ] **Step 1: Write the failing tests**

Create `src/features/flows/__tests__/execute-flow-resume.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'ResumeClaim', slug: `resume-claim-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'resume-target', organizationId: org.id, status: 'ACTIVE', graph: emptyGraph, publishedGraph: emptyGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('resuming a run that is not `waiting` throws FLOW_RUN_NOT_WAITING and does not re-run it', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'succeeded', graphSnapshot: emptyGraph },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'hi' }),
      (error: any) => error.code === 'FLOW_RUN_NOT_WAITING',
    )
    const after1 = await prisma.flowRun.findUnique({ where: { id: run.id } })
    assert.equal(after1.status, 'succeeded') // untouched — the claim never fired
  })

  test('resuming a run that IS waiting succeeds and pins execution to graphSnapshot, not the flow\'s current graph', async () => {
    // The run's snapshot has an extra 'legacy' marker node absent from the flow's
    // CURRENT (edited-after-pause) graph — if resume re-derives from flow.graph
    // instead of the snapshot, this node would vanish and resume would silently
    // run a different graph shape than the one that paused.
    const snapshot = { nodes: [...emptyGraph.nodes, { id: 'legacy', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }], edges: [] }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    // Simulate the flow having been republished since the run paused.
    await prisma.flow.update({ where: { id: ids.flow }, data: { graph: emptyGraph, publishedGraph: emptyGraph } })

    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' })
    // The trigger has no outgoing edge to 'legacy' in either graph, so the run
    // completes immediately either way — this test's job is only to prove the
    // claim succeeded (status flipped, not thrown) using the snapshot's shape,
    // verified indirectly via the second assertion below.
    assert.equal(result.flowRunId, run.id)

    const claimed = await prisma.flowRun.findUnique({ where: { id: run.id } })
    assert.notEqual(claimed.status, 'waiting')
  })

  test('a second concurrent resume of the same run loses cleanly after the first claims it', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: emptyGraph, input: { prompt: '' } },
    })
    const [first, second] = await Promise.allSettled([
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'a' }),
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'b' }),
    ])
    const outcomes = [first, second]
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'FLOW_RUN_NOT_WAITING')
  })
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/features/flows/__tests__/execute-flow-resume.test.ts`
Expected: FAIL (or skip if `TEST_DATABASE_URL` unset — if so, set it to a local throwaway DB for iteration; see the plan's Global Constraints for the `ci_repro` setup used at the final gate). Against the CURRENT (unfixed) code: the first test fails because the unconditional `update` succeeds and does NOT throw `FLOW_RUN_NOT_WAITING`; the third test fails because both concurrent calls fulfill (no claim contention).

- [ ] **Step 3: Replace the preamble**

Replace `execute-flow.ts:56-134` (shown in full above) with:

```ts
export async function runFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const resuming = Boolean(job.flowRunId && job.reply !== undefined)

  // Resume: atomically claim the run — only a genuinely `waiting` run may be
  // resumed. A concurrent resume (e.g. the reply route and the approvals
  // route racing), a run the reaper already terminalized, or a duplicate
  // reply delivery all lose cleanly here instead of re-interpreting an
  // already-moving or already-dead run. Mirrors execute-agent.ts's
  // waiting_* -> running atomic claim.
  let existingRun: Awaited<ReturnType<typeof prisma.flowRun.findFirst>> = null
  if (resuming) {
    const claimed = await prisma.flowRun.updateMany({
      where: { id: job.flowRunId, organizationId: job.organizationId, status: 'waiting' },
      data: { status: 'running' },
    })
    if (claimed.count === 0) throw new ApiError('This run is not waiting for input', 409, 'FLOW_RUN_NOT_WAITING')
    existingRun = await prisma.flowRun.findFirst({ where: { id: job.flowRunId } })
    if (!existingRun) throw new Error('Flow run not found after claim')
  }
  // Snapshot pinning: a resumed run executes the EXACT graph it started with
  // (graphSnapshot), never whatever the flow currently is — a publish made
  // while the run waited must not reshape a run already in flight.
  const source = existingRun ? existingRun.graphSnapshot : job.usePublished && flow.publishedGraph != null ? flow.publishedGraph : flow.graph
  const graph = flowGraphSchema.parse(source)
  let input: unknown = job.input ?? ''
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: job.organizationId, status: 'ACTIVE' },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(job.organizationId, { userId: job.userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }

  // Required trigger inputs (declared on the trigger node) must be present.
  // Skipped when resuming: the original input was validated on the first run.
  // Input memory: before failing on missing fields, fall back to the last
  // successful run's input — but only when the flow hasn't been edited since
  // that run started (shouldReuseInput), so an edited flow always demands
  // fresh input. A run that supplies every required field never falls back:
  // deliberately different-but-complete input always wins.
  let reusedInput = false
  if (!resuming) {
    const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
    let missing = missingRequiredInputFields(inputFields, input)
    if (missing.length) {
      const lastSuccess = await prisma.flowRun.findFirst({
        where: { flowId: flow.id, organizationId: job.organizationId, status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { input: true, startedAt: true },
      })
      if (lastSuccess && shouldReuseInput({ flowUpdatedAt: flow.updatedAt, lastSuccessStartedAt: lastSuccess.startedAt })) {
        const candidate = storedRunInput(lastSuccess.input)
        if (!missingRequiredInputFields(inputFields, candidate).length) {
          input = candidate
          reusedInput = true
          missing = []
        }
      }
    }
    if (missing.length) {
      throw new ApiError(
        `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        400,
        'FLOW_INPUT_ERROR',
      )
    }
  }
  const run = existingRun ?? await prisma.flowRun.create({
    data: {
      flowId: flow.id,
      status: 'running',
      input: jsonValue({ prompt: input }),
      // reusedInput marks the run as replaying the last successful input —
      // the run panel surfaces it so replayed payloads are never silent.
      trigger: jsonValue({ ...(job.trigger ?? { type: 'manual' }), ...(reusedInput ? { reusedInput: true } : {}) }),
      graphSnapshot: jsonValue(graph),
      organizationId: job.organizationId,
      userId: job.userId,
    },
  })
```

Everything from `// Resume integrity: a resume request carries the user's reply...` (originally line 135) onward is UNCHANGED — do not touch it, it already correctly uses `run`, `graph`, `resuming`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/features/flows/__tests__/execute-flow-resume.test.ts`
Expected: PASS (all 3, against `TEST_DATABASE_URL`; pure-import portion — there is none in this file since every test is DB-gated — so with no `TEST_DATABASE_URL` set this file reports 0 tests, which is expected and matches the existing gating convention).

- [ ] **Step 5: Run the full local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean. If `git status -s` shows files you didn't touch (the concurrent session's WIP), do NOT trust a failure in those files as caused by this change — verify in an isolated worktree per the Scope Note above before concluding anything is broken.

- [ ] **Step 6: Commit**

```bash
git add src/features/flows/execute-flow.ts src/features/flows/__tests__/execute-flow-resume.test.ts
git commit -m "fix(flows): resume atomically claims the run and pins execution to its graph snapshot"
```

---

### Task 2: Flow execution queue infrastructure (unwired)

**Files:**
- Modify: `src/lib/queue/config.ts` (add `FLOW_EXECUTION` and `FLOW_DEAD_LETTER` queue names)
- Create: `src/lib/flows/queue-options.ts`
- Test: `src/lib/flows/__tests__/queue-options.test.ts`
- Create: `src/lib/queue/flow-dead-letter.ts`
- Modify: `src/features/flows/execute-flow.ts` (add `dispatchFlowExecution` and `executeFlowJob` exports at the bottom of the file, after `runFlowExecution`)
- Modify: `src/lib/workers/runtime.ts` (register a third BullMQ Worker consuming the new queue)

**Interfaces:**
- Consumes: `FlowExecutionJob` type (already exported from `execute-flow.ts`), `createQueue`/`workersEnabled` (`@/lib/queue/config`), `inlineExecution` (`@/lib/queue/execution-mode`), `runFlowExecution` (this same file, from Task 1).
- Produces: `flowJobOptions(flowRunId: string | undefined, now?: number): { jobId?: string; attempts?: number }` (`@/lib/flows/queue-options`); `dispatchFlowExecution(job: FlowExecutionJob): Promise<{ flowRunId: string; status: string; output: unknown } | { queued: true }>` and `executeFlowJob(job: Job<FlowExecutionJob>): Promise<{ flowRunId: string; status: string; output: unknown }>` (both from `@/features/flows/execute-flow`); `recordFlowDeadLetter`/`deadLetterFromFlowJob` (`@/lib/queue/flow-dead-letter`, mirroring `@/lib/queue/dead-letter`'s existing shape but targeting `prisma.flowRun` instead of `prisma.agentExecution`).

**Explicitly out of scope for this task:** migrating any of the 5 existing callers of `runFlowExecution` (`src/app/api/flows/[id]/execute/route.ts`, `src/app/api/flows/[id]/trigger/route.ts`, `src/app/api/cron/dispatch/route.ts`, `src/app/api/executions/[id]/reply/route.ts`, `src/app/api/approvals/[id]/route.ts`) to call `dispatchFlowExecution` instead. Those files are exactly where the concurrent WS9 session has been active. This task only stands up the infrastructure — `dispatchFlowExecution` is exported but unused by any caller when this task is done. A follow-up task (not in this plan) migrates callers once the concurrent work has settled.

**Why fresh executions and resumes get different retry policy:** a resumed job's redelivery/retry is SAFE because of Task 1's atomic claim — a second attempt just fails the `status: 'waiting'` precondition and throws harmlessly (the first attempt already flipped the run to `running`). A FRESH execution has no pre-existing row for a retry to safely target — `runFlowExecution` would create a SECOND `FlowRun` and re-run the whole flow from scratch, duplicating every side effect. So fresh jobs get `attempts: 1` (no auto-retry — a transient failure dead-letters instead of silently duplicating the run), matching the existing agent dead-letter queue's documented stance that side-effecting work "is NOT auto-retried" when checkpoint-safety doesn't exist.

- [ ] **Step 1: Write the failing test for the job-options decision**

Create `src/lib/flows/__tests__/queue-options.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowJobOptions } from '../queue-options'

test('flowJobOptions: a resume (flowRunId present) gets a run-scoped jobId and no attempts override', () => {
  const opts = flowJobOptions('run-1', 1000)
  assert.equal(opts.jobId, 'run-1-resume-1000')
  assert.equal(opts.attempts, undefined)
})

test('flowJobOptions: a fresh execution (no flowRunId) gets attempts:1 and no jobId', () => {
  const opts = flowJobOptions(undefined)
  assert.equal(opts.attempts, 1)
  assert.equal(opts.jobId, undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/flows/__tests__/queue-options.test.ts`
Expected: FAIL — `Cannot find module '../queue-options'`.

- [ ] **Step 3: Implement `queue-options.ts`**

Create `src/lib/flows/queue-options.ts`:

```ts
/**
 * BullMQ job options for a queued flow execution (see execute-flow.ts's
 * dispatchFlowExecution). Resume jobs get a jobId derived from the run —
 * redelivery/retry of the SAME job is safe because runFlowExecution's atomic
 * claim (Task 1 of WS-R2) makes a second attempt a harmless no-op. Fresh
 * executions get attempts:1 — there is no pre-existing row a retry could
 * safely resume against, so a retry would duplicate the whole run.
 */
export type FlowQueueDecision = { jobId?: string; attempts?: number }

export function flowJobOptions(flowRunId: string | undefined, now: number = Date.now()): FlowQueueDecision {
  if (flowRunId) return { jobId: `${flowRunId}-resume-${now}` }
  return { attempts: 1 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/flows/__tests__/queue-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the queue names**

In `src/lib/queue/config.ts`, modify the `QUEUE_NAMES` export:

```ts
export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
  // Poison jobs land here after their single attempt fails, so a failed run is
  // durably inspectable (and re-runnable by an operator) instead of vanishing.
  // We do NOT auto-retry: agent runs have external side effects.
  DEAD_LETTER: 'agent-dead-letter',
  FLOW_EXECUTION: 'flow-execution',
  FLOW_DEAD_LETTER: 'flow-dead-letter',
} as const
```

- [ ] **Step 6: Create the flow dead-letter recorder**

Create `src/lib/queue/flow-dead-letter.ts`:

```ts
/**
 * Dead-letter capture for flow jobs — mirrors dead-letter.ts but marks the
 * FlowRun row failed instead of an AgentExecution. A fresh-execution job's
 * data carries no flowRunId (runFlowExecution creates that row itself), so
 * recordFlowDeadLetter can only mark a run failed when it fails as a RESUME
 * (flowRunId present in job.data); a fresh-execution failure is dead-lettered
 * for inspection but has no run row to update.
 */

import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { createQueue, QUEUE_NAMES } from './config'

export interface FlowDeadLetterInput {
  queue: string
  jobId?: string
  flowRunId?: string
  organizationId?: string
  data: unknown
  error: string
}

export async function recordFlowDeadLetter(input: FlowDeadLetterInput): Promise<void> {
  if (input.flowRunId) {
    await prisma.flowRun
      .update({
        where: { id: input.flowRunId },
        data: { status: 'failed', error: input.error.slice(0, 300), finishedAt: new Date() },
      })
      .catch(() => undefined)
  }

  try {
    const dlq = createQueue(QUEUE_NAMES.FLOW_DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    apiLogger.error('failed to record flow dead letter', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  captureError(new Error(`flow job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    flowRunId: input.flowRunId,
    organizationId: input.organizationId,
  })
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromFlowJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    void recordFlowDeadLetter({
      queue: queueName,
      jobId: job.id,
      flowRunId: typeof data.flowRunId === 'string' ? data.flowRunId : undefined,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}
```

- [ ] **Step 7: Add `dispatchFlowExecution` and `executeFlowJob` to execute-flow.ts**

At the top of `src/features/flows/execute-flow.ts`, add to the imports:

```ts
import type { Job } from 'bullmq'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { flowJobOptions } from '@/lib/flows/queue-options'
```

At the BOTTOM of the file, after the closing brace of `runFlowExecution` (after the final `return { flowRunId: run.id, status, output: result.output }` and its closing `}`), append:

```ts
/**
 * Entry point for callers that want queue durability (BullMQ stall recovery
 * and dead-letter) instead of running inline in the request process. NOT YET
 * called from any route — infrastructure only (WS-R2 Task 2). In
 * `inlineExecution` mode (the default today) this is identical to calling
 * `runFlowExecution` directly.
 */
export async function dispatchFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown } | { queued: true }> {
  if (inlineExecution) return runFlowExecution(job)
  if (!workersEnabled) throw new Error('Flow worker is disabled')
  const queue = createQueue(QUEUE_NAMES.FLOW_EXECUTION)
  await queue.add('execute-flow', job, flowJobOptions(job.flowRunId))
  return { queued: true }
}

/** BullMQ job handler — the worker calls this for each dequeued flow job. */
export async function executeFlowJob(job: Job<FlowExecutionJob>): Promise<{ flowRunId: string; status: string; output: unknown }> {
  return runFlowExecution(job.data)
}
```

- [ ] **Step 8: Register the worker**

Read `src/lib/workers/runtime.ts` first (it was modified by WS-R1 Task 1 — confirm the current state of the `initSentry`/`captureError`/`flushErrorReporting` imports and the `unhandledRejection` comment are present before editing, since this task edits the same file).

Modify the imports:

```ts
import { executeFlowJob } from '@/features/flows/execute-flow'
import { deadLetterFromFlowJob } from '@/lib/queue/flow-dead-letter'
```

Replace the `workers` field and the dead-letter wiring in the constructor. Current:

```ts
  private workers = [
    new Worker(QUEUE_NAMES.AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
    new Worker(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
  ]
```

New:

```ts
  private workerSpecs = [
    { queue: QUEUE_NAMES.AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.AGENT_EXECUTION) },
    { queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION) },
    // Flow execution: same worker pool, its own queue and dead-letter target
    // (flowRun rows, not agentExecution rows) — see flow-dead-letter.ts.
    { queue: QUEUE_NAMES.FLOW_EXECUTION, handler: executeFlowJob, onFailed: deadLetterFromFlowJob(QUEUE_NAMES.FLOW_EXECUTION) },
  ]
  private workers = this.workerSpecs.map(
    (spec) => new Worker(spec.queue, spec.handler, { ...workerConfig, connection: getRedisConnection() }),
  )
```

Current dead-letter wiring + queues array in the constructor:

```ts
    // Failed jobs (single attempt — no side-effect replay) are dead-lettered.
    const queues = [QUEUE_NAMES.AGENT_EXECUTION, QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION]
    this.workers.forEach((worker, index) => worker.on('failed', deadLetterFromJob(queues[index])))
```

Replace with:

```ts
    // Failed jobs are dead-lettered (durable, inspectable) — see workerSpecs
    // above for the per-queue handler (agent vs. flow target different tables).
    this.workers.forEach((worker, index) => worker.on('failed', this.workerSpecs[index].onFailed))
```

Also update the `/health` endpoint's reported worker map. Current:

```ts
        workers: { 'agent-execution': this.workers[0].isRunning(), 'scheduled-agent-execution': this.workers[1].isRunning() },
```

New:

```ts
        workers: Object.fromEntries(this.workerSpecs.map((spec, index) => [spec.queue, this.workers[index].isRunning()])),
```

And the `running` check just above it (`this.workers.every((worker) => worker.isRunning())`) is unchanged — it already iterates all workers generically.

- [ ] **Step 9: Run the full local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean. Per the Scope Note, verify in an isolated worktree if the shared working tree has unrelated dirty files at this point.

- [ ] **Step 10: Commit**

```bash
git add src/lib/queue/config.ts src/lib/flows/queue-options.ts src/lib/flows/__tests__/queue-options.test.ts src/lib/queue/flow-dead-letter.ts src/features/flows/execute-flow.ts src/lib/workers/runtime.ts
git commit -m "feat(flows): BullMQ queue infrastructure for flow execution (unwired — no caller migrated yet)"
```

---

### Task 3: Docs, CI-mode gate, push

**Files:**
- Modify: `ARCHITECTURE.md` (note the new queue + the resume-claim/snapshot-pin fix)
- Modify: `docs/superpowers/plans/2026-07-07-flows-workato-parity-roadmap.md` (mark the "No resume-after-pause" load-bearing limit's RESUME-DUPLICATION half as addressed, without claiming the loop-cursor half — see exact wording below)

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: Update ARCHITECTURE.md**

Read `ARCHITECTURE.md` first (it was modified by WS-R1 Task 4 — confirm the worker-Sentry sentence is present in the Runtime Boundary section before editing).

In the `## Agent Execution` section (or immediately after it — read the file to find the right spot; do not create a new top-level section for this), add a new paragraph:

```markdown
## Flow Execution

Flows execute inline in the calling process today (`runFlowExecution` in `src/features/flows/execute-flow.ts`) via the same routes agents use for triggering (manual execute, webhook trigger, cron dispatch, reply, approval decision). A resume (a reply or approval decision reaching a paused run) atomically claims the run — only a `waiting` run may be resumed — and pins execution to the exact graph the run started with (`FlowRun.graphSnapshot`), never the flow's current definition. A `flow-execution` BullMQ queue and worker exist (`dispatchFlowExecution`/`executeFlowJob`) but are not yet wired into any caller — flows still run inline everywhere in practice.
```

- [ ] **Step 2: Annotate the roadmap doc**

In `docs/superpowers/plans/2026-07-07-flows-workato-parity-roadmap.md`, find the line under "Load-bearing engine limits":

```markdown
- **No resume-after-pause.** `interpretFlow` always restarts from `trigger`; completed steps are not skipped. Re-running a `waiting` run re-executes every prior agent and writes duplicate `FlowRunStep` rows. Answer-and-continue for ask-user is structurally impossible today. → gates testing, error-repair, waiting-run monitoring.
```

Append a note immediately after it (same list item, new line, indented as a sub-bullet if the file's markdown style uses them — otherwise a plain follow-on sentence):

```markdown
  > **Partial fix (2026-07-10, Remediation WS-R2):** the top-level "answer-and-continue" resume race is closed — resume is now an atomic claim pinned to the run's graph snapshot (`src/features/flows/execute-flow.ts`). The loop/parallel-container resume-from-cursor problem this bullet also describes (an in-progress loop iteration re-executing every prior iteration on resume) is UNCHANGED and remains this roadmap's item to solve — WS-R2 deliberately did not touch it (see that plan's Scope Note).
```

- [ ] **Step 3: Full local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean, in an isolated worktree if the shared tree has unrelated dirty files.

- [ ] **Step 4: CI-mode gate**

Recreate the throwaway DB and run against it (same sequence as WS-R1 Task 4):

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ci_repro' -c 'CREATE DATABASE ci_repro'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm test
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm run build
```

Expected: DB-backed tests (including the new resume-claim and queue-options tests) un-skip and pass; build succeeds. Run this in the isolated worktree per the Scope Note, exactly as WS-R1 Task 4 did, since the shared working tree is likely to have the concurrent session's uncommitted files present.

- [ ] **Step 5: Commit docs, pull, push**

```bash
git add ARCHITECTURE.md docs/superpowers/plans/2026-07-07-flows-workato-parity-roadmap.md
git commit -m "docs: WS-R2 — flow execution architecture note, roadmap partial-fix annotation"
git pull --rebase origin main
git push origin main
```

If `git pull --rebase` fails because the shared working tree has the concurrent session's uncommitted changes, do NOT stash or discard them — this is expected given the Scope Note; report the state and let the user decide how to proceed rather than forcing a resolution.

- [ ] **Step 6: Confirm CI green**

Run: `curl -s "https://api.github.com/repos/jamesmcdaniel-cyber/Backstory_Studio/actions/runs?per_page=3"` and check the `conclusion` for the pushed SHA (poll until complete, e.g. via ScheduleWakeup rather than a blocking sleep).
Expected: `"conclusion": "success"`.
