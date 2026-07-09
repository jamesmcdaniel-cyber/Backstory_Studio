# Agent Memory & Intelligence — Plan 2: Surfacing & UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec `docs/superpowers/specs/2026-07-08-agent-memory-intelligence-design.md` section 3: make plan 1's engine visible — memory CRUD API, goal field + toggles (+ suggested-goal confirmation) in the agent config form, activity-pane surfaces (PLAN card, Suggestions card with dismiss + deep-link, answered-from-memory card, memory-recalled card, suggested-answer prefill), and a Memory section listing what the agent knows.

**Architecture:** One new API route (`/api/agents/[id]/memories`) serves list/dismiss/delete. The config form gains a `goal` textarea (new `AgentTask.goal` column already exists; the agents PUT route learns to persist it) plus the two metadata toggles, mirroring the existing `allowSubagents` pattern. The activity pane's `buildTimeline` learns the four new event kinds from plan 1; the waiting-for-input box prefills from the latest `agent.question` event's `suggestedAnswer`. The Memory list renders as a section inside the config form (the form has no tab system — spec's "Memory tab" adapts to a section, documented deviation).

**Tech Stack:** Next.js App Router, existing UI kit (Badge/Button/Input/Switch), `prisma.agentMemory` (plan 1), `WorkflowEvent` stream, zod.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- No component test infra — API routes follow the repo's existing untested-route pattern; verification everywhere is `npm run typecheck && npm run lint && npm test` (baseline 327 pass / 6 skip; 4 pre-existing lint warnings).
- Exact strings from plan 1 (do not drift): event kinds `agent.plan`, `agent.suggestion`, `agent.question.autoanswered`, `memory.retrieved`; suggestion payload `{ memoryId, deduped, title, rationale, actionType }`; question payload `suggestedAnswer: { content, memoryId }`; memory kinds `user_answer | learning | suggestion`; statuses `open | dismissed | superseded`; metadata keys `autoAnswerFromMemory`, `alwaysStrategize`, `lastCritique`, `suggestedGoal`.
- Agent-scoped API routes derive the id from `request.nextUrl.pathname.split('/')` (match sibling routes under `src/app/api/agents/[id]/`) and must scope by `organizationId` + the same visibility helper those siblings use (read one, e.g. `knowledge/route.ts`, and mirror its auth/ownership pattern exactly).
- Never run `npm run dev`/`npm run build`/prisma migrate commands.

---

### Task 1: Memory CRUD API

**Files:**
- Create: `src/app/api/agents/[id]/memories/route.ts`

**Interfaces:**
- Produces (Tasks 3-4 consume):
  - `GET /api/agents/<id>/memories?kind=<kind>&status=<status>` → `{ success: true, memories: [{ id, kind, title, content, question, status, timesUsed, lastUsedAt, sourceExecutionId, createdAt }], openSuggestions: number }` (filters optional; default lists `status != 'superseded'`, newest first, take 200; `openSuggestions` always the open-suggestion count)
  - `PATCH` body `{ id: string, status: 'dismissed' | 'open' }` → `{ success: true }` (suggestion dismiss/restore)
  - `DELETE` body `{ id?: string, all?: boolean }` → `{ success: true, deleted: number }` (`all: true` clears the agent's memories)

- [ ] **Step 1: Implement the route**

Create `src/app/api/agents/[id]/memories/route.ts`. Read `src/app/api/agents/[id]/knowledge/route.ts` FIRST and mirror: the `withAuthenticatedApi` wrapper, the id extraction, and the agent ownership/visibility check it performs before touching child rows. Then:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
// + the same visibility/ownership imports the knowledge route uses

export const runtime = 'nodejs'

// (mirror the knowledge route's agent-loading helper here, e.g.:)
async function requireAgent(request: NextRequest, auth: AuthContext) {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId /* + visibility scope like the sibling route */ },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const agent = await requireAgent(request, auth)
  const kind = request.nextUrl.searchParams.get('kind') ?? undefined
  const status = request.nextUrl.searchParams.get('status') ?? undefined
  const [memories, openSuggestions] = await Promise.all([
    prisma.agentMemory.findMany({
      where: {
        organizationId: auth.organizationId,
        agentId: agent.id,
        ...(kind ? { kind } : {}),
        ...(status ? { status } : { status: { not: 'superseded' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, kind: true, title: true, content: true, question: true,
        status: true, timesUsed: true, lastUsedAt: true, sourceExecutionId: true, createdAt: true,
      },
    }),
    prisma.agentMemory.count({
      where: { organizationId: auth.organizationId, agentId: agent.id, kind: 'suggestion', status: 'open' },
    }),
  ])
  return { success: true, memories, openSuggestions }
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const agent = await requireAgent(request, auth)
  const { id, status } = z.object({ id: z.string(), status: z.enum(['dismissed', 'open']) }).parse(await request.json())
  const updated = await prisma.agentMemory.updateMany({
    where: { id, organizationId: auth.organizationId, agentId: agent.id },
    data: { status },
  })
  if (updated.count !== 1) throw new ApiError('Memory not found', 404, 'NOT_FOUND')
  return { success: true }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const agent = await requireAgent(request, auth)
  const body = z.object({ id: z.string().optional(), all: z.boolean().optional() }).parse(await request.json().catch(() => ({})))
  if (!body.id && !body.all) throw new ApiError('Provide id or all')
  const deleted = await prisma.agentMemory.deleteMany({
    where: {
      organizationId: auth.organizationId,
      agentId: agent.id,
      ...(body.all ? {} : { id: body.id }),
    },
  })
  return { success: true, deleted: deleted.count }
})
```

(The snippet's `requireAgent` is illustrative — mirror the sibling route's actual pattern and imports; keep the endpoint shapes exactly as the Interfaces block states.)

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/api/agents/[id]/memories/route.ts'
git commit -m "feat(agents): memory list/dismiss/delete API"
```

---

### Task 2: Goal field, toggles, suggested-goal confirmation

**Files:**
- Modify: `src/app/api/agents/route.ts` (PUT accepts + persists `goal`; clears `metadata.suggestedGoal` when a goal is saved)
- Modify: `src/app/dashboard/agent-config-form.tsx`

**Interfaces:**
- Consumes: `AgentTask.goal` column; metadata keys `autoAnswerFromMemory`, `alwaysStrategize`, `suggestedGoal`.
- Produces: PUT `/api/agents` body gains optional `goal: string | null`; the form's draft gains `goal`, `autoAnswerFromMemory`, `alwaysStrategize`.

- [ ] **Step 1: PUT route**

In `src/app/api/agents/route.ts` PUT handler: add `goal: z.string().max(2000).nullable().optional()` to its body schema (read the existing schema shape first); in the update `data`, when `goal !== undefined` write `goal: goal?.trim() ? goal.trim() : null` AND inside the merged metadata object drop the proposal: `suggestedGoal: undefined` (only when goal was provided). Keep everything else identical.

- [ ] **Step 2: Config form**

In `src/app/dashboard/agent-config-form.tsx` (943 lines — locate by content):
- Draft type + `emptyDraft`/load-from-source (~line 355 region) gain: `goal: source.goal || ''`, `autoAnswerFromMemory: source.autoAnswerFromMemory === true`, `alwaysStrategize: source.alwaysStrategize === true` (check how `allowSubagents` flows from the agent row's metadata into `source` and mirror it for the two toggles; `goal` comes from the agent row column — confirm the fetch includes it, add if the API response omits it).
- Save path (~line 448 region): include `goal: draft.goal.trim() || null` in the PUT body and the two toggles alongside `allowSubagents` in metadata.
- UI, near the objective/instructions textarea: a `Larger goal (optional)` textarea (2 rows, helper text `The outcome this agent ultimately serves — it steers every run and self-evaluation.`).
- Suggested-goal banner directly above that field when the agent's `metadata.suggestedGoal` exists and `draft.goal` is empty:

```tsx
  <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 text-sm text-indigo-900">
    <p><span className="font-semibold">Suggested goal:</span> {suggestedGoal}</p>
    <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, goal: suggestedGoal })}>
      Use it
    </Button>
  </div>
```

- Two `Switch` rows next to the existing `allowSubagents` switch (~line 713), copying its exact row markup: `Answer from memory automatically` (helper: `When a question closely matches one you've answered before, the agent reuses your answer instead of pausing.`) and `Always strategize` (helper: `Every run starts with an explicit numbered plan before any tool call.`).

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/app/api/agents/route.ts src/app/dashboard/agent-config-form.tsx
git commit -m "feat(agents): goal field, memory/strategize toggles, suggested-goal confirmation"
```

---

### Task 3: Activity-pane surfaces

**Files:**
- Modify: `src/app/dashboard/agent-activity-pane.tsx`

**Interfaces:**
- Consumes: event kinds + payload shapes from Global Constraints; `PATCH /api/agents/<id>/memories` (Task 1) for dismissing suggestions; `GET …?kind=suggestion&status=open` for the badge count.

- [ ] **Step 1: Timeline kinds**

In `buildTimeline` (~line 431) add three item kinds:

```ts
  | { key: string; ts: number; kind: 'plan'; text: string }
  | { key: string; ts: number; kind: 'memory'; summary: string }
  | { key: string; ts: number; kind: 'autoanswer'; question: string; answer: string }
```

Mapping: `agent.plan` (payload.text) → 'plan'; `memory.retrieved` (payload.summary) → 'memory'; `agent.question.autoanswered` (payload.question/answer) → 'autoanswer'. Collect `agent.suggestion` events into a separate return value — change `buildTimeline` to return `{ items, suggestions }` where `suggestions: { memoryId: string; title: string; rationale: string; actionType: string }[]` (update the caller accordingly).

- [ ] **Step 2: Cards**

Next to `ThinkingCard`/`ContextCard` (copy their styling conventions):
- `PlanCard({ text })` — dashed-border card, `ListOrdered` icon, eyebrow `PLAN`, whitespace-pre-wrap text.
- `MemoryCard({ summary })` — like the context card's collapsed row, `Brain` icon, eyebrow `MEMORY`, just the summary line.
- `AutoAnswerCard({ question, answer })` — `MessageSquareQuote` (or similar existing lucide) icon, eyebrow `ANSWERED FROM MEMORY`, question in muted text, answer bold.
- `SuggestionsCard({ suggestions, agentId, onChanged })` — rendered AFTER the timeline (not inside it) when non-empty: lightbulb icon header `Suggestions`, one row per item (title bold, rationale muted, `actionType === 'connect'` renders a small `Link` to `/connections` labeled `Open connections`), per-row dismiss ✕ → `fetch(PATCH /api/agents/${agentId}/memories, { id: memoryId, status: 'dismissed' })` then hide the row locally (`useState` set of dismissed ids) and call `onChanged()`.
- Wire the new kinds into the timeline `.map` render chain.

- [ ] **Step 3: Suggested-answer prefill**

In the `waiting_for_input` block (~line 545): derive `const suggested = [...(details?.events ?? [])].reverse().find((e) => e.kind === 'agent.question' && e.payload?.suggestedAnswer)?.payload?.suggestedAnswer as { content: string } | undefined`. When present and `reply === ''`, render under the input row:

```tsx
  {suggested && !reply && (
    <button type="button" onClick={() => setReply(suggested.content)} className="mt-2 flex items-center gap-1.5 text-xs font-medium text-indigo-700 hover:text-indigo-900">
      <History className="h-3.5 w-3.5" /> Use previous answer: <span className="italic">“{suggested.content.slice(0, 80)}”</span>
    </button>
  )}
```

- [ ] **Step 4: Lightbulb badge**

In the pane's header region where the agent title/selector renders (locate the component top — it receives the selected agent), fetch the open-suggestion count once per agent change (`GET /api/agents/${agent.id}/memories?kind=suggestion&status=open`, read `openSuggestions`) and render, when > 0, a small badge next to the title: `Lightbulb` icon + count, `title="Open suggestions from this agent's runs"`. Refresh it via the same `onChanged` path used after dismissals.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/app/dashboard/agent-activity-pane.tsx
git commit -m "feat(dashboard): plan/memory/auto-answer cards, suggestions with dismiss, answer prefill, suggestion badge"
```

---

### Task 4: Memory section in the config form

**Files:**
- Modify: `src/app/dashboard/agent-config-form.tsx`

**Interfaces:**
- Consumes: Task 1's GET/DELETE endpoints.

- [ ] **Step 1: Memory section**

Below the existing `Recent runs` section (~line 890, mirror its `eyebrow` header style), add a `Memory` section for EXISTING agents only (skip when creating):
- On mount/agent change: `GET /api/agents/${agentId}/memories` → list state.
- Render rows: kind badge (`user_answer` → `Answer`, `learning` → `Learning`, `suggestion` → `Suggestion`; reuse `Badge` variants), title (bold, truncate), content (line-clamp-2 muted), `question` shown italic above content for answers, `Last used` date when present, per-row trash button → `DELETE { id }` then remove locally.
- Header row right side: `Clear all memory` ghost button (red text) with `window.confirm('Clear everything this agent has learned? This cannot be undone.')` → `DELETE { all: true }` → empty the list.
- Empty state: `Nothing learned yet — memories appear after runs complete.`
- Spec deviation note (documented here): the spec says "Memory tab"; the config form has no tab system, so this ships as a section — same content, same controls.

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/app/dashboard/agent-config-form.tsx
git commit -m "feat(agents): memory section — view, delete, clear what the agent has learned"
```

---

### Task 5: Final verification

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test` — all green.
- [ ] **Step 2:** Reasoning smoke checklist: suggestion dismiss flips status (badge count drops); goal saves to the column and clears `suggestedGoal`; toggles round-trip through metadata; prefill only when a `suggestedAnswer` exists and the reply box is empty; PLAN/MEMORY/AUTOANSWER cards render only for their event kinds; memory clear-all confirmed + irreversible.
