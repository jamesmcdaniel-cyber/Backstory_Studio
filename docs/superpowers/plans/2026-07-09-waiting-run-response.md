# WS8: Waiting-Run Visibility & Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 8: waiting flow runs explain what they're waiting on and are answerable — from the builder's Runs panel AND the Activity page — with a deep-link back to the builder.

**Architecture:** The pause reason is persisted where it's produced (the `runAgent` adapter's waiting branch writes `{ waiting: { kind, question?, approvalId? } }` into the waiting FlowRunStep's `output`); the runs API derives a run-level `waiting` object server-side so summary mode stays slim; the existing resume endpoint (`POST /api/flows/[id]/execute { flowRunId, reply }`) gets its first UI drivers.

**Tech Stack:** Prisma (no schema change — `output` is Json), Next.js App Router, React 18, node:test.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent. Baseline at plan time: 397 pass / 6 skip, 4 pre-existing lint warnings. Never run dev/build/prisma locally; CI-mode gate (ci_repro Postgres + build) before push.
- NO schema migration — the pause reason lives in the existing `FlowRunStep.output` Json column.
- Waiting kinds come from `runAgentExecution` results: `'waiting_for_input'` (has `question`) and `'waiting_for_approval'` (has `approvalId`). User-facing copy NEVER shows these raw strings: input-kind renders "Waiting for your reply", approval-kind renders "Waiting for an approval decision".
- Resume contract unchanged: `POST /api/flows/[id]/execute` body `{ flowRunId, reply }`. Replies only make sense for input-kind waits — the UI hides the reply box for approval-kind.
- Version-view read-only gating in the builder is untouched (the Runs panel already renders in both modes; replying is not a graph mutation and stays allowed).
- No raw `{{` or internal enum strings in any new user-visible copy.

---

### Task 1: Persist the pause reason + expose it in the runs API

**Files:**
- Modify: `src/features/flows/execute-flow.ts` (runAgent adapter waiting branch, ~line 164)
- Modify: `src/app/api/flows/[id]/runs/route.ts`

**Interfaces:**
- Produces (API): every shaped run gains `waiting: { nodeId: string, kind: 'input' | 'approval', question?: string } | null` — non-null only when `run.status === 'waiting'`. Present in BOTH summary and full modes.
- Produces (storage): the waiting FlowRunStep's `output` = `{ waiting: { kind: 'input' | 'approval', question?: string, approvalId?: string } }`.

- [ ] **Step 1: Persist at pause**

In the runAgent adapter's waiting branch (`if (typeof result?.status === 'string' && result.status.startsWith('waiting'))`), extend the step update:

```ts
const kind = result.status === 'waiting_for_approval' ? 'approval' : 'input'
await prisma.flowRunStep.update({
  where: { id: step.id },
  data: {
    status: 'waiting',
    agentExecutionId: result.executionId ?? null,
    output: jsonValue({ waiting: { kind, question: result.question, approvalId: (result as { approvalId?: string }).approvalId } }),
    finishedAt: new Date(),
  },
})
```

Resume safety check (verify, don't change): the resume scan reuses output only for `succeeded`/`skipped` steps, so this output is never fed back as step data.

- [ ] **Step 2: Derive run-level `waiting` in the API**

In the runs route, the steps select in summary mode must ALSO fetch `output` for waiting steps — simplest correct approach: always include `output` in the Prisma select, but strip it from the shaped summary steps (keep the wire payload slim). Then:

```ts
const waitingOf = (run: (typeof runs)[number]) => {
  if (run.status !== 'waiting') return null
  const step = run.steps.find((s) => s.status === 'waiting')
  if (!step) return null
  const info = (step.output as { waiting?: { kind?: string, question?: string } } | null)?.waiting
  return { nodeId: step.nodeId, kind: info?.kind === 'approval' ? 'approval' as const : 'input' as const, question: info?.question }
}
```

Shaped run gains `waiting: waitingOf(run)`; summary steps are re-mapped to `{ nodeId, status, order, error }` (dropping the fetched output).

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test` (baseline holds — route/adapter glue, existing interpreter tests unaffected).

```bash
git add src/features/flows/execute-flow.ts 'src/app/api/flows/[id]/runs/route.ts'
git commit -m "feat(flows): persist pause reason on waiting steps and expose it from the runs API"
```

---

### Task 2: Builder — Runs panel reply UI, `?run=` deep-link, pause toast action

**Files:**
- Modify: `src/components/flows/run-panel.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: `FlowRunDetail` (run-panel's own type — extend with `waiting?: { nodeId: string, kind: 'input' | 'approval', question?: string } | null`), the runs API field from Task 1, `POST /api/flows/[id]/execute` `{ flowRunId, reply }`.
- Produces: `RunPanel` new optional prop `onReply?: (flowRunId: string, reply: string) => Promise<void>`; page implements it and gains `?run=<id>` deep-link handling.

- [ ] **Step 1: RunPanel waiting banner + reply box**

When `selected.status === 'waiting' && selected.waiting`, render above the steps list a `rounded-md border border-blue-200 bg-blue-50 p-3` banner:
- Input kind: heading `Waiting for your reply`, the question text (or `The agent asked a question.` when question missing), a textarea + `Send reply` button (loading state, disabled when empty). Submit → `onReply(selected.id, text)` → clear box. Errors → `toast.error`.
- Approval kind: heading `Waiting for an approval decision`, body `A step needs an approval before this run can continue.` No reply box.
- The waiting STEP row also shows `Waiting for your reply` / `Waiting for approval` instead of the bare status word (find the step-row status rendering and special-case waiting when the run's `waiting.nodeId` matches).

- [ ] **Step 2: Page wiring — onReply + deep-link + toast action**

- `onReply`: POST `/api/flows/[id]/execute` with `{ flowRunId, reply }`; on success `toast.success('Reply sent — resuming the flow.')` and trigger the existing runs polling/refresh (find `pollRuns` and reuse); on failure surface `data.error`.
- Deep-link: on mount, read `useSearchParams().get('run')` — if present, `setShowRuns(true)` and select that run once runs load (the panel has a selection mechanism; follow it — pass an initial selected run id prop or effect-select after fetch). Strip nothing from the URL (harmless to keep).
- Pause toast (page ~line 578): replace `toast('The flow paused for input on a step.')` with `toast('The flow is waiting for your reply.', { action: { label: 'View', onClick: () => setShowRuns(true) } })` (check sonner's action API usage elsewhere in the repo; if unused elsewhere, this form is correct for sonner).

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/run-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): answer waiting runs from the builder — reply UI, run deep-link, actionable pause toast"
```

---

### Task 3: Activity page — waiting banner, inline reply, open-in-builder

**Files:**
- Modify: `src/app/flows/[id]/activity/page.tsx` (read fully first — it fetches `summary=1` runs and renders the table in the screenshot)

**Interfaces:**
- Consumes: `waiting` field from Task 1 (present in summary mode), resume endpoint.

- [ ] **Step 1: Implement**

- Each run row gains an `Open in builder` link → `/flows/${id}?run=${run.id}` (subtle text link, right-aligned near the error column or in the expanded detail).
- Waiting runs: in the expanded detail (and visible without expanding — a banner directly under the row when `run.waiting`), render the same blue banner as the Runs panel: question + reply textarea + `Send reply` for input kind; approval copy for approval kind. Submit → POST `/api/flows/[id]/execute` `{ flowRunId, reply }` → `toast.success` → refetch the runs list (reuse the page's existing fetch function).
- The waiting step row inside the expanded steps list shows `Waiting for your reply` instead of `Waiting` when it's the waiting node.
- Status chip copy: keep `Waiting` (scannable) — the banner carries the explanation.

- [ ] **Step 2: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/flows/[id]/activity/page.tsx'
git commit -m "feat(flows): activity page — see and answer what a waiting run needs, jump back to builder"
```

---

### Task 4: Final verification + review + push

- [ ] Full gate at baseline; whole-workstream review (most capable model) on the review package; fix Critical/Important.
- [ ] CI-mode gate (ci_repro DB tests + build), then push.
