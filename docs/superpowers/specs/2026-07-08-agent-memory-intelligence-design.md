# Agent Memory & Intelligence Design

**Date:** 2026-07-08
**Status:** Approved
**Parent:** Workstream 1.9 of `2026-07-08-flow-parity-design.md`
**Goal:** Agents retain information from previous runs, understand larger goals, self-optimize every run, surface actionable suggestions, strategize through complicated tasks, and leverage graph RAG substantially more — all six capabilities in one coherent build.

## Decisions made

| Decision | Choice |
|---|---|
| Memory scope | Per agent, org-shared — the agent gets smarter for everyone in the org |
| Delivery | All six capabilities in one push (single workstream, multiple plans if needed) |
| System of record | Postgres (`AgentMemory` model); Neo4j graph indexing layered on top when `ragEnabled()` |
| Auto-answer from memory | Injection + one-click prefill by default; silent auto-answer is a per-agent opt-in toggle |

## Context (verified against the codebase)

- Graph RAG exists and is solid but gated: Voyage embeddings (`VOYAGE_API_KEY`) + Neo4j (`neo4jConfigured()`); `ragEnabled()` requires both. Store interface `src/lib/rag/store.ts` (node types incl. `agent`, `run`, `insight`), Neo4j vector index, two-stage `retrieveContext` (`topK=6`, `hops=2`), `renderContext`. Runs are indexed post-completion by `indexExecution` (fire-and-forget).
- The execution loop (`src/features/agents/execute-agent.ts`) has NO reflection pass and NO durable memory: goals live in `AgentTask.objective`, ask-user answers die with the execution, `metadata` JSON is the only scratch space.
- `KnowledgeChunk` establishes the Postgres-embedding pattern (embedding Json + `cosine`/`keywordScore` fallback) that `AgentMemory` mirrors.
- Process log = `WorkflowEvent` rows (`context.retrieved`, `agent.thinking`, `tool.*`), rendered by `src/app/dashboard/agent-activity-pane.tsx`.
- Ask-user pause/resume: `ASK_USER_TOOL` + `PendingQuestion` + `metadata.pendingQuestion`; resume path replays completed steps.

---

## 1. Memory substrate

### Model

```prisma
model AgentMemory {
  id                 String    @id @default(cuid())
  organizationId     String    @db.Uuid
  agentId            String              // AgentTask id; cascade delete
  kind               String              // 'user_answer' | 'learning' | 'suggestion'
  title              String              // short label for lists
  content            String    @db.Text  // the memory itself (answer / learning / suggestion body)
  question           String?   @db.Text  // user_answer: the question that was asked
  embedding          Json?               // number[] via Voyage; null when unconfigured
  sourceExecutionId  String?             // run that produced it
  status             String    @default("open") // 'open' | 'dismissed' | 'superseded'
  timesUsed          Int       @default(0)
  lastUsedAt         DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  @@index([organizationId, agentId, kind, status])
  @@map("agent_memories")
}
```

Postgres is the system of record (durable in every environment). When `ragEnabled()`, each memory is also indexed into the graph as an `insight` node edged to `agent:<id>` — so cross-agent/graph retrieval sees it ("used for other tasks").

### Retrieval

`retrieveAgentMemory({ organizationId, agentId, query, k })` in `src/lib/memory/retrieve.ts` — cosine over embeddings when configured, `keywordScore` fallback otherwise (exact mirror of `retrieveKnowledge`). Never throws. Rendered as a third context block in the system prompt: `## What you've learned (from previous runs)`. Injection cap: top-6 memories + the latest self-critique, ~1.5k tokens.

### Input memory (ask-user answers)

- On ask-user reply (resume path), persist `{ kind: 'user_answer', question, content: reply }` with an embedding of the question.
- Remembered answers are part of the injected memory block, so agents stop asking answered questions.
- If the agent still asks, a similarity matcher (`matchRememberedAnswer(question, memories)` — cosine ≥ 0.86, else keyword fallback heuristic) attaches the best previous answer to the `agent.question` event payload; the activity pane pre-fills the reply box with a "Use previous answer" affordance.
- Per-agent toggle `autoAnswerFromMemory` (default false): when on and the matcher confidence is high, the ask-user tool call is resolved from memory without pausing, logged as a distinct process event (`agent.question.autoanswered`) so it's auditable.

---

## 2. Intelligence loop

### Goal understanding

- `AgentTask.goal String? @db.Text` — the larger *why* behind the objective. Editable in the agent config form.
- When null, the first reflection pass infers a goal from the objective and stores it as a proposal (`metadata.suggestedGoal`); the config form shows it for one-click confirmation.
- System prompt gains a `## Larger goal` section when set; reflection evaluates output against the goal, not just task completion.

### Post-run reflection (self-optimization)

After every completed run, one cheap-model call (injectable runner; same `createModelRunner` machinery) receives goal + objective + run summary + condensed process log and returns structured JSON (zod-validated, tolerant parsing):

```ts
{ learnings: { title, content }[],      // what worked/failed, where data lives
  selfCritique: string,                  // one paragraph: do differently next time
  suggestions: { title, rationale, actionType?: 'connect' | 'config' | 'data' | 'other' }[],
  goalAssessment: string }               // how well the output served the goal
```

- Learnings + critique stored as `learning` memories; the latest critique is ALWAYS injected next run as `## Notes to self from last run` — run N's mistakes shape run N+1.
- Fire-and-forget next to `indexExecution`: reflection failure never fails a run.
- Reflection model kept cheap (env-overridable default, e.g. the platform's small model tier).

### Strategize mode

- System prompt section `## Think before acting`: first turn must produce a numbered plan BEFORE any tool call; revisit the plan when a step fails.
- Activation heuristic (`shouldStrategize(task)`): objective length, tool count, `maxTurns` above default — OR the per-agent `alwaysStrategize` toggle.
- The plan is emitted as an `agent.plan` `WorkflowEvent`; the activity pane renders a distinct PLAN card (like THINKING blocks).

### Deeper graph-RAG

1. Retrieval seeds include the agent's own node (`agent:<id>`) so `expand()` pulls its past runs + linked insights.
2. `indexExecution`'s run-node text is enriched with reflection learnings (today: status line + truncated output).
3. `retrieveContext` `topK/hops` scale up for strategize-mode runs (e.g. 6→10, 2→3).
4. Memories indexed as `insight` nodes (Section 1).

---

## 3. Surfacing, control, testing

### Suggestions surface

- Each reflection suggestion → `suggestion` memory + `agent.suggestion` `WorkflowEvent`.
- Activity pane: Suggestions card at the end of a completed run (title, rationale, dismiss control → memory `status: 'dismissed'`); `actionType: 'connect'` deep-links to `/connections`.
- Agent header: lightbulb badge with the open-suggestion count.
- Dedupe: new suggestion embedded, dropped when ≥ threshold similar to an open one (`timesUsed++` on the survivor — recurring suggestions rank higher).

### Memory tab (agent config dialog)

- List memories: kind badge, title/content, source run link, last used; per-item delete; "Clear all memory."
- Toggles: `autoAnswerFromMemory`, `alwaysStrategize` (stored in `AgentTask.metadata`).
- API: `GET/DELETE /api/agents/[id]/memories` (+ `DELETE` all), org+visibility scoped.

### Error handling

- Reflection + memory writes: fire-and-forget, logged, never fail the run.
- Memory retrieval never throws; empty results degrade to today's behavior.
- Graph indexing only when `ragEnabled()`; Postgres always.
- Cascade delete with the agent; memory list capped per agent (e.g. 500, oldest superseded first) to bound growth.

### Testing

- Pure units: similarity matcher thresholds, dedupe, injection cap/rendering, `shouldStrategize`, reflection JSON parsing (tolerant), goal-section builder, memory scoring (cosine + keyword fallback).
- Reflection call unit-tested via injected fake runner.
- Route tests for memory CRUD scoping.
- Verification: typecheck + lint + test locally; behavior validated on Vercel preview.

## Out of scope

- Cross-org or user-private memory scopes (schema allows later; no UI now)
- Memory editing (view/delete only)
- Automatic goal drift detection
- Backfilling memories from historical executions
