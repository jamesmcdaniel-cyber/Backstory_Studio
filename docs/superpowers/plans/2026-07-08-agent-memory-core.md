# Agent Memory & Intelligence — Plan 1: Memory Substrate + Intelligence Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec `docs/superpowers/specs/2026-07-08-agent-memory-intelligence-design.md`, sections 1-2: the `AgentMemory` substrate (Postgres system-of-record, graph-indexed when available), input memory from ask-user replies (with opt-in auto-answer), post-run reflection (learnings/critique/suggestions), goal awareness, strategize mode, and the graph-RAG upgrades. Plan 2 (separate) covers the UI surfaces (memory tab, suggestion cards, prefill, PLAN card, goal field).

**Architecture:** New pure-ish modules — `src/lib/memory/agent-memory.ts` (save/retrieve/render/match, mirroring `src/lib/knowledge/retrieve.ts`), `src/features/agents/reflection.ts` (structured post-run call via the existing `generateStructured`, injectable for tests), `src/features/agents/strategy.ts` (`shouldStrategize` + prompt sections) — wired into `execute-agent.ts` at four existing seams: prompt build, ask-user pause, ask-user resume, and run completion. All memory/reflection writes are fire-and-forget.

**Tech Stack:** Prisma 6 (hand-authored migration, `prisma migrate deploy` on Vercel), zod, existing `embedQuery`/`cosine`/`keywordScore`, `generateStructured` (model-runner), `WorkflowEvent` stream, `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- Tests: `node:test` + `node:assert/strict` in `__tests__/*.test.ts`; pure functions get tests, DB/LLM paths get injectable deps + fakes.
- NO local DB: never run `npm run dev`/`npm run build`/`prisma migrate dev`/`db push`. Hand-author migration SQL (mirror conventions in `prisma/migrations/`); run `npx prisma generate` after schema edits.
- Verification everywhere: `npm run typecheck && npm run lint && npm test` (current baseline 301 pass / 6 skip; 4 pre-existing lint warnings).
- Exact values from the spec: memory kinds `'user_answer' | 'learning' | 'suggestion'`; status `'open' | 'dismissed' | 'superseded'`; similarity threshold `0.86` (cosine) for answer-match AND suggestion dedupe; keyword-fallback match threshold `0.6`; injection cap top-6 memories; per-agent memory cap `500`; toggles in `AgentTask.metadata`: `autoAnswerFromMemory` (default false), `alwaysStrategize` (default false); event kinds `agent.plan`, `agent.suggestion`, `agent.question.autoanswered`; prompt headings exactly `## Larger goal`, `## What you've learned (from previous runs)`, `## Notes to self from last run`, `## Think before acting`.
- Never let memory/reflection failures fail a run: wrap in try/catch or `void ….catch()`, log via `apiLogger.warn`.

---

### Task 1: Schema — AgentMemory model + AgentTask.goal

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<UTC-timestamp>_agent_memory/migration.sql`

**Interfaces:**
- Produces: `prisma.agentMemory` client with the spec's fields; `AgentTask.goal: string | null`. All later tasks depend on these.

- [ ] **Step 1: Schema edits**

Add to `prisma/schema.prisma` (near AgentTask):

```prisma
model AgentMemory {
  id                String    @id @default(cuid())
  organizationId    String    @db.Uuid
  agentId           String
  kind              String    // 'user_answer' | 'learning' | 'suggestion'
  title             String
  content           String    @db.Text
  question          String?   @db.Text
  embedding         Json?
  sourceExecutionId String?
  status            String    @default("open") // 'open' | 'dismissed' | 'superseded'
  timesUsed         Int       @default(0)
  lastUsedAt        DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  agent        AgentTask    @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([organizationId, agentId, kind, status])
  @@map("agent_memories")
}
```

Add back-relations: `memories AgentMemory[]` on `AgentTask`, `agentMemories AgentMemory[]` on `Organization` (match each model's existing relation-list style/naming section). Add to `AgentTask`: `goal String? @db.Text` (place next to `objective`).

- [ ] **Step 2: Hand-author the migration**

Check `agent_tasks`' primary-key type and the FK/quoting conventions in existing migrations (grep `REFERENCES "agent_tasks"` and the org FK style), then create `prisma/migrations/<timestamp>_agent_memory/migration.sql`:

```sql
ALTER TABLE "agent_tasks" ADD COLUMN "goal" TEXT;

CREATE TABLE "agent_memories" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "agentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "question" TEXT,
  "embedding" JSONB,
  "sourceExecutionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "timesUsed" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_memories_organizationId_agentId_kind_status_idx"
  ON "agent_memories"("organizationId", "agentId", "kind", "status");

ALTER TABLE "agent_memories"
  ADD CONSTRAINT "agent_memories_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_memories"
  ADD CONSTRAINT "agent_memories_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Adjust table/column types ONLY if your convention check shows differences (e.g. organizations table name, JSONB vs JSON — mirror `knowledge_chunks.embedding`'s column type).

- [ ] **Step 3: Generate + verify + commit**

Run: `npx prisma generate && npm run typecheck && npm run lint && npm test`

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(agents): AgentMemory model + AgentTask.goal"
```

---

### Task 2: Memory core module

**Files:**
- Create: `src/lib/memory/agent-memory.ts`
- Test: `src/lib/memory/__tests__/agent-memory.test.ts`

**Interfaces:**
- Consumes: `prisma`, `embedQuery`/`embeddingsConfigured` from `@/lib/rag/embeddings`, `cosine`/`keywordScore` from `@/lib/knowledge/retrieve`.
- Produces (Tasks 3-6 + plan 2 depend on these exact names):
  - `MEMORY_SIMILARITY_THRESHOLD = 0.86`, `KEYWORD_MATCH_THRESHOLD = 0.6`, `MEMORY_INJECTION_LIMIT = 6`, `AGENT_MEMORY_CAP = 500`
  - `type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number }`
  - `saveAgentMemory(params: { organizationId: string; agentId: string; kind: 'user_answer' | 'learning' | 'suggestion'; title: string; content: string; question?: string; sourceExecutionId?: string }): Promise<{ id: string; deduped: boolean } | null>` — embeds best-effort; suggestion-dedupe (cosine ≥ threshold vs open suggestions → `timesUsed++`, return `{ deduped: true }`); enforces the 500 cap (supersede oldest `learning`s beyond cap); returns null on failure (never throws)
  - `retrieveAgentMemory(params: { organizationId: string; agentId: string; query: string; k?: number }): Promise<MemoryHit[]>` — open memories only, cosine else keyword, never throws
  - `renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string` — `## What you've learned (from previous runs)` block (+ `## Notes to self from last run` when critique present); '' when both empty
  - `bestAnswerMatch(questionVec: number[] | null, question: string, candidates: { id: string; question: string | null; content: string; embedding: unknown }[]): { id: string; content: string; score: number } | null` — pure: cosine ≥ 0.86 when vectors available, else `keywordScore(question, candidate.question) ≥ 0.6`
  - `markMemoriesUsed(ids: string[]): Promise<void>` — `timesUsed++`/`lastUsedAt`, best-effort

- [ ] **Step 1: Write the failing tests**

Create `src/lib/memory/__tests__/agent-memory.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestAnswerMatch,
  renderAgentMemories,
  MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_INJECTION_LIMIT,
} from '../agent-memory'

const vec = (x: number, y: number) => [x, y]

test('bestAnswerMatch picks the closest embedded question above 0.86', () => {
  const candidates = [
    { id: 'm1', question: 'Which region should I focus on?', content: 'EMEA', embedding: vec(1, 0) },
    { id: 'm2', question: 'What is the pipeline threshold?', content: '$50k', embedding: vec(0, 1) },
  ]
  const hit = bestAnswerMatch(vec(0.99, 0.05), 'Which region?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(hit?.content, 'EMEA')
  assert.ok(hit!.score >= MEMORY_SIMILARITY_THRESHOLD)
})

test('bestAnswerMatch returns null below the threshold', () => {
  const candidates = [{ id: 'm1', question: 'Which region?', content: 'EMEA', embedding: vec(1, 0) }]
  assert.equal(bestAnswerMatch(vec(0.5, 0.87), 'unrelated', candidates), null)
})

test('bestAnswerMatch falls back to keyword overlap without vectors', () => {
  const candidates = [
    { id: 'm1', question: 'Which Salesforce region should the report cover?', content: 'EMEA', embedding: null },
  ]
  const hit = bestAnswerMatch(null, 'Which Salesforce region should this cover?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(bestAnswerMatch(null, 'completely different topic entirely', candidates), null)
})

test('renderAgentMemories renders headings, caps, and critique', () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`, kind: 'learning', title: `T${i}`, content: `Learned ${i}`, question: null, score: 1 - i / 10,
  }))
  const block = renderAgentMemories(hits.slice(0, MEMORY_INJECTION_LIMIT), 'Do fewer tool calls next time.')
  assert.match(block, /## What you've learned \(from previous runs\)/)
  assert.match(block, /Learned 0/)
  assert.match(block, /## Notes to self from last run/)
  assert.match(block, /fewer tool calls/)
  assert.equal(renderAgentMemories([], null), '')
  assert.match(renderAgentMemories([], 'note'), /## Notes to self from last run/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/memory/__tests__/agent-memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/memory/agent-memory.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedQuery, embeddingsConfigured } from '@/lib/rag/embeddings'
import { cosine, keywordScore } from '@/lib/knowledge/retrieve'

export const MEMORY_SIMILARITY_THRESHOLD = 0.86
export const KEYWORD_MATCH_THRESHOLD = 0.6
export const MEMORY_INJECTION_LIMIT = 6
export const AGENT_MEMORY_CAP = 500

export type MemoryKind = 'user_answer' | 'learning' | 'suggestion'
export type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number }

function embeddingOf(value: unknown): number[] | null {
  return Array.isArray(value) ? (value as number[]) : null
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null
  try {
    return await embedQuery(text.slice(0, 4000))
  } catch {
    return null
  }
}

/**
 * Persist one agent memory. Suggestions are deduped against open suggestions
 * (>= threshold cosine bumps timesUsed on the survivor instead of inserting).
 * Enforces the per-agent cap by superseding the oldest learnings. Never throws.
 */
export async function saveAgentMemory(params: {
  organizationId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  question?: string
  sourceExecutionId?: string
}): Promise<{ id: string; deduped: boolean } | null> {
  try {
    const embedText = params.kind === 'user_answer' ? params.question ?? params.content : `${params.title}\n${params.content}`
    const embedding = await tryEmbed(embedText)

    if (params.kind === 'suggestion' && embedding) {
      const open = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, kind: 'suggestion', status: 'open' },
        select: { id: true, embedding: true },
        take: 100,
      })
      for (const candidate of open) {
        const vec = embeddingOf(candidate.embedding)
        if (vec && cosine(embedding, vec) >= MEMORY_SIMILARITY_THRESHOLD) {
          await prisma.agentMemory.update({
            where: { id: candidate.id },
            data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
          })
          return { id: candidate.id, deduped: true }
        }
      }
    }

    const created = await prisma.agentMemory.create({
      data: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title.slice(0, 200),
        content: params.content,
        question: params.question,
        embedding: embedding ?? undefined,
        sourceExecutionId: params.sourceExecutionId,
      },
    })

    // Cap: supersede the oldest open learnings beyond the limit.
    const openCount = await prisma.agentMemory.count({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
    })
    if (openCount > AGENT_MEMORY_CAP) {
      const overflow = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open', kind: 'learning' },
        orderBy: { createdAt: 'asc' },
        take: openCount - AGENT_MEMORY_CAP,
        select: { id: true },
      })
      if (overflow.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: overflow.map((m) => m.id) } },
          data: { status: 'superseded' },
        })
      }
    }

    return { id: created.id, deduped: false }
  } catch (error) {
    apiLogger.warn('saveAgentMemory failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** Top-k open memories for this agent, cosine when embedded else keyword. Never throws. */
export async function retrieveAgentMemory(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
}): Promise<MemoryHit[]> {
  const k = params.k ?? MEMORY_INJECTION_LIMIT
  try {
    const rows = await prisma.agentMemory.findMany({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
      select: { id: true, kind: true, title: true, content: true, question: true, embedding: true },
      orderBy: { createdAt: 'desc' },
      take: AGENT_MEMORY_CAP,
    })
    if (!rows.length) return []
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query.slice(0, 2000))
      } catch {
        queryVec = null
      }
    }
    const scored = rows.map((row) => {
      const vec = embeddingOf(row.embedding)
      const text = `${row.title}\n${row.question ?? ''}\n${row.content}`
      const score = queryVec && vec ? cosine(queryVec, vec) : keywordScore(params.query, text)
      return { id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0).slice(0, k)
  } catch {
    return []
  }
}

/** Render memory + critique blocks for the system prompt. '' when empty. */
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string {
  const parts: string[] = []
  if (hits.length) {
    const body = hits
      .map((h) => {
        if (h.kind === 'user_answer' && h.question) return `— Previously asked: "${h.question}" → the user answered: ${h.content}`
        return `— ${h.title}: ${h.content}`
      })
      .join('\n')
    parts.push(`## What you've learned (from previous runs)\nApply these remembered facts and lessons; do not re-ask questions the user already answered unless something changed.\n\n${body}`)
  }
  if (latestCritique?.trim()) {
    parts.push(`## Notes to self from last run\n${latestCritique.trim()}`)
  }
  return parts.join('\n\n')
}

/** Pure matcher: closest remembered answer for a question, or null. */
export function bestAnswerMatch(
  questionVec: number[] | null,
  question: string,
  candidates: { id: string; question: string | null; content: string; embedding: unknown }[],
): { id: string; content: string; score: number } | null {
  let best: { id: string; content: string; score: number } | null = null
  for (const candidate of candidates) {
    const vec = embeddingOf(candidate.embedding)
    const score =
      questionVec && vec
        ? cosine(questionVec, vec)
        : candidate.question
          ? keywordScore(question, candidate.question)
          : 0
    const threshold = questionVec && vec ? MEMORY_SIMILARITY_THRESHOLD : KEYWORD_MATCH_THRESHOLD
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: candidate.id, content: candidate.content, score }
    }
  }
  return best
}

/** Bump usage counters. Best-effort. */
export async function markMemoriesUsed(ids: string[]): Promise<void> {
  if (!ids.length) return
  try {
    await prisma.agentMemory.updateMany({
      where: { id: { in: ids } },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    })
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Run tests, full suite, commit**

Run: `npx tsx --test src/lib/memory/__tests__/agent-memory.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/memory/agent-memory.ts src/lib/memory/__tests__/agent-memory.test.ts
git commit -m "feat(agents): agent memory core — save, retrieve, render, match"
```

---

### Task 3: Reflection module

**Files:**
- Create: `src/features/agents/reflection.ts`
- Test: `src/features/agents/__tests__/reflection.test.ts`

**Interfaces:**
- Consumes: `generateStructured` from `@/lib/llm/model-runner` (signature: `(opts: { system: string; user: string; schema: Record<string, unknown>; schemaName: string; maxTokens?: number }) => Promise<string>`), `saveAgentMemory` (Task 2), `prisma`, `apiLogger`.
- Produces:
  - `type Reflection = { learnings: { title: string; content: string }[]; selfCritique: string; suggestions: { title: string; rationale: string; actionType?: 'connect' | 'config' | 'data' | 'other' }[]; goalAssessment: string; suggestedGoal?: string }`
  - `parseReflection(raw: string): Reflection | null` (tolerant: zod-validated after fence-stripping; null on garbage)
  - `buildReflectionPrompt(params: { goal: string | null; objective: string; summary: string; processLog: string }): { system: string; user: string }`
  - `reflectAndRemember(params: { organizationId: string; agentId: string; executionId: string; goal: string | null; objective: string; summary: string; processLog: string; recordSuggestionEvent: (payload: Record<string, unknown>) => Promise<void> }, deps?: { generate?: typeof generateStructured }): Promise<Reflection | null>` — Task 4 wires this at run completion; plan 2 renders the events.

- [ ] **Step 1: Write the failing tests**

Create `src/features/agents/__tests__/reflection.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReflection, buildReflectionPrompt } from '../reflection'

test('parseReflection accepts clean JSON', () => {
  const parsed = parseReflection(JSON.stringify({
    learnings: [{ title: 'Snowflake table', content: 'Upsell data lives in ANALYTICS.UPSELL' }],
    selfCritique: 'Query Snowflake before Salesforce next time.',
    suggestions: [{ title: 'Connect Salesforce', rationale: 'SOQL segmentation needs it', actionType: 'connect' }],
    goalAssessment: 'Partially served the goal.',
  }))
  assert.equal(parsed?.learnings[0].title, 'Snowflake table')
  assert.equal(parsed?.suggestions[0].actionType, 'connect')
})

test('parseReflection tolerates code fences and drops invalid actionType', () => {
  const fenced = '```json\n' + JSON.stringify({
    learnings: [], selfCritique: 'ok', suggestions: [{ title: 'x', rationale: 'y', actionType: 'weird' }], goalAssessment: '',
  }) + '\n```'
  const parsed = parseReflection(fenced)
  assert.equal(parsed?.suggestions[0].actionType, 'other')
})

test('parseReflection returns null on garbage', () => {
  assert.equal(parseReflection('not json at all'), null)
  assert.equal(parseReflection('{"learnings": "nope"}'), null)
})

test('buildReflectionPrompt includes goal, objective, summary, log', () => {
  const { system, user } = buildReflectionPrompt({
    goal: 'Grow upsell pipeline', objective: 'Score accounts', summary: 'Scored 12 accounts', processLog: 'tool: search…',
  })
  assert.match(system, /reflection/i)
  assert.match(user, /Grow upsell pipeline/)
  assert.match(user, /Score accounts/)
  assert.match(user, /Scored 12 accounts/)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx tsx --test src/features/agents/__tests__/reflection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/features/agents/reflection.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'

const ACTION_TYPES = ['connect', 'config', 'data', 'other'] as const

const reflectionSchema = z.object({
  learnings: z.array(z.object({ title: z.string(), content: z.string() })).default([]),
  selfCritique: z.string().default(''),
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        actionType: z
          .string()
          .optional()
          .transform((value) => (ACTION_TYPES.includes(value as (typeof ACTION_TYPES)[number]) ? (value as (typeof ACTION_TYPES)[number]) : 'other')),
      }),
    )
    .default([]),
  goalAssessment: z.string().default(''),
  suggestedGoal: z.string().optional(),
})

export type Reflection = z.infer<typeof reflectionSchema>

export const REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    learnings: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
    },
    selfCritique: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, rationale: { type: 'string' }, actionType: { type: 'string', enum: [...ACTION_TYPES] } },
        required: ['title', 'rationale'],
      },
    },
    goalAssessment: { type: 'string' },
    suggestedGoal: { type: 'string' },
  },
  required: ['learnings', 'selfCritique', 'suggestions', 'goalAssessment'],
}

/** Tolerant parse: strip fences, find the object, validate. Null on garbage. */
export function parseReflection(raw: string): Reflection | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = reflectionSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      /* try next */
    }
  }
  return null
}

export function buildReflectionPrompt(params: {
  goal: string | null
  objective: string
  summary: string
  processLog: string
}): { system: string; user: string } {
  return {
    system:
      'You are the reflection pass for an autonomous agent. Given a completed run, extract durable learnings (facts about where data lives, what worked, what failed), one short self-critique paragraph the agent should read before its next run, and up to 3 user-actionable suggestions that would help future runs serve the larger goal better (missing connections, data gaps, objective improvements). Be concrete and terse. If no goal was provided, infer one from the objective and return it as suggestedGoal.',
    user: [
      `Larger goal: ${params.goal ?? '(none provided — infer one)'}`,
      `Objective: ${params.objective}`,
      `Run summary:\n${params.summary.slice(0, 6000)}`,
      `Process log (condensed):\n${params.processLog.slice(0, 6000)}`,
    ].join('\n\n'),
  }
}

/**
 * Post-run reflection: one structured LLM call, then persist learnings /
 * critique / suggestions as agent memories and emit suggestion events.
 * Fire-and-forget by callers; never throws.
 */
export async function reflectAndRemember(
  params: {
    organizationId: string
    agentId: string
    executionId: string
    goal: string | null
    objective: string
    summary: string
    processLog: string
    recordSuggestionEvent: (payload: Record<string, unknown>) => Promise<void>
  },
  deps: { generate?: typeof generateStructured } = {},
): Promise<Reflection | null> {
  try {
    const generate = deps.generate ?? generateStructured
    const { system, user } = buildReflectionPrompt(params)
    const raw = await generate({ system, user, schema: REFLECTION_JSON_SCHEMA, schemaName: 'agent_reflection', maxTokens: 1500 })
    const reflection = parseReflection(raw)
    if (!reflection) return null

    for (const learning of reflection.learnings.slice(0, 5)) {
      await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'learning',
        title: learning.title,
        content: learning.content,
        sourceExecutionId: params.executionId,
      })
    }

    if (reflection.selfCritique.trim()) {
      // The latest critique is ALWAYS injected next run — store it on the task
      // metadata (single slot), not as an accumulating memory row.
      const agent = await prisma.agentTask.findUnique({ where: { id: params.agentId }, select: { metadata: true, goal: true } })
      const metadata = (agent?.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata) ? agent.metadata : {}) as Record<string, unknown>
      await prisma.agentTask.update({
        where: { id: params.agentId },
        data: {
          metadata: {
            ...metadata,
            lastCritique: reflection.selfCritique.slice(0, 1500),
            ...(reflection.suggestedGoal && !agent?.goal ? { suggestedGoal: reflection.suggestedGoal.slice(0, 500) } : {}),
          },
        },
      })
    }

    for (const suggestion of reflection.suggestions.slice(0, 3)) {
      const saved = await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'suggestion',
        title: suggestion.title,
        content: suggestion.rationale,
        sourceExecutionId: params.executionId,
      })
      if (saved) {
        await params
          .recordSuggestionEvent({
            memoryId: saved.id,
            deduped: saved.deduped,
            title: suggestion.title,
            rationale: suggestion.rationale,
            actionType: suggestion.actionType ?? 'other',
          })
          .catch(() => undefined)
      }
    }

    return reflection
  } catch (error) {
    apiLogger.warn('reflectAndRemember failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
```

- [ ] **Step 4: Add a fake-runner test for reflectAndRemember**

Append to the test file (uses the injectable `generate` so no LLM/network; the prisma calls inside will fail without a DB — so the test targets the parse/prompt layers only and verifies the generate wiring via a stub that throws AFTER capture, keeping the test DB-free):

```ts
test('reflectAndRemember calls generate with the built prompt and tolerates downstream failure', async () => {
  const { reflectAndRemember } = await import('../reflection')
  let captured: { system: string; user: string } | null = null
  const result = await reflectAndRemember(
    {
      organizationId: 'org', agentId: 'agent', executionId: 'exec',
      goal: null, objective: 'obj', summary: 'sum', processLog: 'log',
      recordSuggestionEvent: async () => undefined,
    },
    {
      generate: async (opts) => {
        captured = { system: opts.system, user: opts.user }
        throw new Error('stop before DB writes')
      },
    },
  )
  assert.equal(result, null)
  assert.match(captured!.user, /infer one/)
})
```

- [ ] **Step 5: Run tests, full suite, commit**

Run: `npx tsx --test src/features/agents/__tests__/reflection.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/features/agents/reflection.ts src/features/agents/__tests__/reflection.test.ts
git commit -m "feat(agents): post-run reflection — learnings, critique, suggestions"
```

---

### Task 4: Strategy module + prompt sections

**Files:**
- Create: `src/features/agents/strategy.ts`
- Test: `src/features/agents/__tests__/strategy.test.ts`

**Interfaces:**
- Produces:
  - `shouldStrategize(params: { objective: string; metadata: Record<string, unknown>; toolCount: number }): boolean` — `metadata.alwaysStrategize === true`, OR objective length > 1200, OR `Number(metadata.maxTurns) > 16`, OR toolCount > 25
  - `goalSection(goal: string | null | undefined): string` — `## Larger goal\n…` or ''
  - `strategizeSection(): string` — the `## Think before acting` directive (first turn = numbered plan before any tool call; revisit on failures)
  - `STRATEGIZE_RETRIEVAL = { topK: 10, hops: 3 }`

- [ ] **Step 1: Write the failing tests**

Create `src/features/agents/__tests__/strategy.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldStrategize, goalSection, strategizeSection, STRATEGIZE_RETRIEVAL } from '../strategy'

test('shouldStrategize triggers on toggle, long objective, high maxTurns, many tools', () => {
  const base = { objective: 'short', metadata: {}, toolCount: 5 }
  assert.equal(shouldStrategize(base), false)
  assert.equal(shouldStrategize({ ...base, metadata: { alwaysStrategize: true } }), true)
  assert.equal(shouldStrategize({ ...base, objective: 'x'.repeat(1201) }), true)
  assert.equal(shouldStrategize({ ...base, metadata: { maxTurns: 24 } }), true)
  assert.equal(shouldStrategize({ ...base, toolCount: 26 }), true)
})

test('goalSection renders the heading or empty', () => {
  assert.match(goalSection('Grow upsell pipeline'), /^## Larger goal\n/)
  assert.equal(goalSection(null), '')
  assert.equal(goalSection('   '), '')
})

test('strategizeSection demands a numbered plan before tools', () => {
  const section = strategizeSection()
  assert.match(section, /^## Think before acting\n/)
  assert.match(section, /numbered plan/i)
  assert.ok(STRATEGIZE_RETRIEVAL.topK === 10 && STRATEGIZE_RETRIEVAL.hops === 3)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx tsx --test src/features/agents/__tests__/strategy.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/features/agents/strategy.ts`:

```ts
/**
 * Strategize-mode heuristics + the goal/strategy prompt sections. Pure module
 * (no Prisma/LLM imports) so it is trivially unit-testable.
 */

export const STRATEGIZE_RETRIEVAL = { topK: 10, hops: 3 }

export function shouldStrategize(params: { objective: string; metadata: Record<string, unknown>; toolCount: number }): boolean {
  if (params.metadata.alwaysStrategize === true) return true
  if (params.objective.length > 1200) return true
  if (Number(params.metadata.maxTurns) > 16) return true
  if (params.toolCount > 25) return true
  return false
}

export function goalSection(goal: string | null | undefined): string {
  const trimmed = goal?.trim()
  if (!trimmed) return ''
  return `## Larger goal\nEverything you do this run should serve this goal: ${trimmed}\nWhen choices arise, pick the option that best advances it, and evaluate your final output against it.`
}

export function strategizeSection(): string {
  return [
    '## Think before acting',
    'This task is complex. Before calling ANY tool, produce a short numbered plan: the steps you will take, which tools each step needs, and what "done" looks like. State the plan in your first reply, then execute it.',
    'When a step fails or returns something unexpected, pause and revise the plan explicitly before continuing.',
  ].join('\n')
}
```

- [ ] **Step 4: Run tests, full suite, commit**

Run: `npx tsx --test src/features/agents/__tests__/strategy.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/features/agents/strategy.ts src/features/agents/__tests__/strategy.test.ts
git commit -m "feat(agents): strategize heuristics + goal/plan prompt sections"
```

---

### Task 5: Execution wiring — prompt injection, ask-user memory, reflection hook

**Files:**
- Modify: `src/features/agents/execute-agent.ts` (four seams; locate by content, the file is ~1260 lines)

**Interfaces:**
- Consumes: everything from Tasks 2-4 (`retrieveAgentMemory`, `renderAgentMemories`, `bestAnswerMatch`, `markMemoriesUsed`, `saveAgentMemory`, `reflectAndRemember`, `shouldStrategize`, `goalSection`, `strategizeSection`, `STRATEGIZE_RETRIEVAL`).
- Produces: runtime behavior + new `WorkflowEvent` kinds `agent.plan`, `agent.suggestion`, `agent.question.autoanswered`; `agent.question` events gain optional `suggestedAnswer` payload (plan 2 renders these).

- [ ] **Step 1: Prompt injection seam**

Add imports at the top of `execute-agent.ts`:

```ts
import { retrieveAgentMemory, renderAgentMemories, bestAnswerMatch, markMemoriesUsed, saveAgentMemory } from '@/lib/memory/agent-memory'
import { reflectAndRemember } from './reflection'
import { shouldStrategize, goalSection, strategizeSection, STRATEGIZE_RETRIEVAL } from './strategy'
```

Locate `let system = buildAgentSystemPrompt(agent.objective, skillIds, communitySkills)`. Directly after the Strata-scope block that follows it, add:

```ts
    // Goal awareness + strategize mode (WS1.9). The goal steers every turn;
    // complex tasks are told to plan before acting.
    const goalBlock = goalSection((agent as { goal?: string | null }).goal)
    if (goalBlock) system += `\n\n${goalBlock}`
    const strategize = shouldStrategize({ objective: agent.objective, metadata: agentMetadata, toolCount: tools.length })
    if (strategize) system += `\n\n${strategizeSection()}`
```

(Note: `agent` is selected via Prisma earlier in the function — confirm the select/include already returns full rows (it uses `findFirst` without `select`, so `goal` is present after Task 1's generate; if a narrow `select` exists, add `goal: true`.)

Locate the graph-RAG block (`const ragContext = await retrieveContext(getGraphRagStore(), {…})`). Two changes: seed the agent's own node and scale retrieval in strategize mode:

```ts
      const seedNodeIds = [
        `agent:${agent.id}`,
        signalRef?.accountId ? `account:${signalRef.accountId}` : null,
        signalRef?.opportunityId ? `opp:${signalRef.opportunityId}` : null,
      ].filter((id): id is string => Boolean(id))
      const ragContext = await retrieveContext(getGraphRagStore(), {
        organizationId,
        viewerUserId: userId,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        seedNodeIds,
        ...(strategize ? { topK: STRATEGIZE_RETRIEVAL.topK, hops: STRATEGIZE_RETRIEVAL.hops } : {}),
      })
```

Directly after the knowledge-retrieval block (the second try/catch that appends `renderKnowledge`), add a third, parallel-shaped block:

```ts
    // Agent memory: remembered answers, learnings, and the latest self-critique
    // from prior runs. Best-effort — never blocks a run.
    try {
      const memoryHits = await retrieveAgentMemory({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
      })
      const critique = typeof agentMetadata.lastCritique === 'string' ? agentMetadata.lastCritique : null
      const memoryBlock = renderAgentMemories(memoryHits, critique)
      if (memoryBlock) {
        system = `${system}\n\n${memoryBlock}`
        void markMemoriesUsed(memoryHits.map((h) => h.id))
        await recordEvent(execution.id, null, 'memory.retrieved', {
          source: 'agent-memory',
          count: memoryHits.length,
          summary: `Recalled ${memoryHits.length} memor${memoryHits.length === 1 ? 'y' : 'ies'} from previous runs${critique ? ' + a note-to-self' : ''}.`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: memory retrieval skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
```

- [ ] **Step 2: Plan-event seam (strategize)**

Locate where the assistant's per-turn narration is recorded as `agent.thinking` (a `recordEvent(…, 'agent.thinking', …)` call inside the turn loop, ~line 950). Introduce a flag before the loop: `let planEmitted = false`, and where the thinking event is recorded change the kind:

```ts
        const thinkingKind = strategize && !planEmitted ? 'agent.plan' : 'agent.thinking'
        if (thinkingKind === 'agent.plan') planEmitted = true
```

…and use `thinkingKind` in that `recordEvent` call (payload unchanged).

- [ ] **Step 3: Ask-user seams**

(a) **Save answers as memory (resume path).** Locate the resume block that records `'user.replied'` (`await recordEvent(queuedExecution.id, pending.stepId || null, 'user.replied', { answer: reply })`, ~line 690). Directly after it add:

```ts
    // Input memory (WS1.9): remember the Q/A so future runs stop re-asking.
    void saveAgentMemory({
      organizationId: queuedExecution.organizationId,
      agentId: queuedExecution.agentTaskId,
      kind: 'user_answer',
      title: pending.question.slice(0, 120),
      content: reply,
      question: pending.question,
      sourceExecutionId: queuedExecution.id,
    })
```

(Adjust the org/agent id property names to the variables actually in scope in that function — check the surrounding code; `queuedExecution` carries the execution row.)

(b) **Auto-answer / suggested answer (pause path).** Locate the ask_user handling block (where `PendingQuestion` is built and the run is set to `waiting_for_input`, ~lines 1080-1126). BEFORE creating the waiting step, add:

```ts
          // Remembered-answer match (WS1.9): auto-answer when the per-agent
          // toggle is on and confidence is high; otherwise attach the best
          // previous answer so the UI can prefill it.
          let suggestedAnswer: { memoryId: string; content: string; score: number } | null = null
          try {
            const remembered = await prisma.agentMemory.findMany({
              where: { organizationId, agentId: agent.id, kind: 'user_answer', status: 'open' },
              select: { id: true, question: true, content: true, embedding: true },
              orderBy: { createdAt: 'desc' },
              take: 100,
            })
            if (remembered.length) {
              let questionVec: number[] | null = null
              if (embeddingsConfigured()) {
                questionVec = await embedQuery(question.slice(0, 2000)).catch(() => null)
              }
              const match = bestAnswerMatch(questionVec, question, remembered)
              if (match) suggestedAnswer = { memoryId: match.id, content: match.content, score: match.score }
            }
          } catch {
            /* best-effort */
          }

          if (suggestedAnswer && agentMetadata.autoAnswerFromMemory === true) {
            await recordEvent(execution.id, null, 'agent.question.autoanswered', {
              question,
              answer: suggestedAnswer.content,
              memoryId: suggestedAnswer.memoryId,
              score: suggestedAnswer.score,
            })
            void markMemoriesUsed([suggestedAnswer.memoryId])
            runner.appendToolResults(transcript, [{ toolCallId: askCall.id, content: suggestedAnswer.content }])
            continue
          }
```

Notes for the implementer: `question` and the ask tool-call variable names must match the local block (read it first — the tool call id variable may be `call.id`/`toolCall.id`; the `continue` must target the turn loop exactly the way a normal tool result continues it — mirror how other tool results are appended and the loop proceeds). Then, where the `agent.question` event is recorded for the pause, extend its payload with `...(suggestedAnswer ? { suggestedAnswer: { content: suggestedAnswer.content, memoryId: suggestedAnswer.memoryId } } : {})`. Add `embedQuery`/`embeddingsConfigured` to the imports from `@/lib/rag/embeddings` if not already imported.

- [ ] **Step 4: Reflection hook (completion seam)**

Locate the completion block (`void indexExecution({ … }).catch(() => undefined)`). Directly before `return { ...output, executionId: execution.id }`, add:

```ts
    // Post-run reflection (WS1.9): distill learnings + critique + suggestions.
    // Chained before graph indexing enrichment is NOT needed — indexExecution
    // already ran; reflection memories are graph-indexed via their own path in
    // plan 2. Fire-and-forget: never blocks or fails the run.
    void reflectAndRemember({
      organizationId,
      agentId: agent.id,
      executionId: execution.id,
      goal: (agent as { goal?: string | null }).goal ?? null,
      objective: agent.objective,
      summary,
      processLog: transcriptSummaryForReflection(transcript),
      recordSuggestionEvent: (payload) => recordEvent(execution.id, null, 'agent.suggestion', payload),
    }).catch(() => undefined)
```

Add this small helper near the other module-level helpers in execute-agent.ts:

```ts
/** Condense the IR transcript into a short tool/step log for reflection. */
function transcriptSummaryForReflection(transcript: unknown): string {
  try {
    const messages = Array.isArray(transcript) ? transcript : []
    const lines: string[] = []
    for (const message of messages as { role?: string; content?: unknown; toolCalls?: { name?: string }[] }[]) {
      if (Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) if (call?.name) lines.push(`tool: ${call.name}`)
      }
      if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
        lines.push(`assistant: ${message.content.slice(0, 200)}`)
      }
    }
    return lines.slice(-60).join('\n')
  } catch {
    return ''
  }
}
```

(Adjust the message-shape property names to the IR types actually used in this file — inspect `coerceToIR`'s IR shape in `src/lib/llm/ir.ts` and mirror the field names; the goal is a rough tool/assistant line log, not fidelity.)

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (no new tests here; the seams are covered by the module tests + typecheck).

```bash
git add src/features/agents/execute-agent.ts
git commit -m "feat(agents): wire memory, goals, strategize, auto-answer, reflection into execution"
```

---

### Task 6: Graph indexing of memories

**Files:**
- Modify: `src/lib/rag/indexer.ts` (new `indexAgentMemory` entry point)
- Modify: `src/lib/memory/agent-memory.ts` (call it fire-and-forget after create)
- Test: extend `src/lib/memory/__tests__/agent-memory.test.ts` only if a pure helper is added; the indexer path is gated + best-effort (no test infra for Neo4j).

**Interfaces:**
- Consumes: existing indexer internals (`ragEnabled` gating pattern, `commit`/`commitGraph` helpers, `nodeIds` scheme, `insight` node type, agent node id `agent:<id>`).
- Produces: `indexAgentMemory(params: { memoryId: string; organizationId: string; agentId: string; kind: string; title: string; content: string; ownerUserId?: string | null }): Promise<void>` — writes node id `insight:mem:<memoryId>` with edge `belongs_to` → `agent:<agentId>`, shared visibility; no-op unless `ragEnabled()`.

- [ ] **Step 1: Implement indexAgentMemory**

In `src/lib/rag/indexer.ts`, following the exact structure of `indexCustomSignalResult` (gating, try/catch + `warn`, `commit`), add:

```ts
/** Index an agent memory as an insight node linked to its agent (WS1.9). */
export async function indexAgentMemory(params: {
  memoryId: string
  organizationId: string
  agentId: string
  kind: string
  title: string
  content: string
  ownerUserId?: string | null
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodeId = `insight:mem:${params.memoryId}`
    const text = `Agent memory (${params.kind}): ${params.title}. ${params.content}`.slice(0, 1500)
    await commit(
      [
        {
          id: nodeId,
          organizationId: params.organizationId,
          type: 'insight' as const,
          text,
          props: { kind: params.kind, agentId: params.agentId },
          ownerUserId: params.ownerUserId ?? undefined,
          visibility: 'shared' as const,
        },
      ],
      [{ from: nodeId, to: `agent:${params.agentId}`, relation: 'belongs_to' as const, organizationId: params.organizationId }],
    )
  } catch (error) {
    warn('indexAgentMemory', error)
  }
}
```

(Adapt the node/edge object shapes and the `commit` helper's exact signature to what the file actually uses — read `indexCustomSignalResult` and mirror it precisely, including how embeddings are batched.)

- [ ] **Step 2: Call it from saveAgentMemory**

In `src/lib/memory/agent-memory.ts`, after the successful `prisma.agentMemory.create`, add:

```ts
    void import('@/lib/rag/indexer')
      .then((indexer) => indexer.indexAgentMemory({
        memoryId: created.id,
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title,
        content: params.content,
      }))
      .catch(() => undefined)
```

(Dynamic import keeps the memory module dependency-light for its unit tests.)

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/rag/indexer.ts src/lib/memory/agent-memory.ts
git commit -m "feat(rag): index agent memories as insight nodes linked to their agent"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green (Tasks 2-4 add ~10 tests to the baseline).

- [ ] **Step 2: Reasoning smoke checklist**

- Run completes → reflection fires → learnings/suggestions in `agent_memories`, critique in `AgentTask.metadata.lastCritique` → next run's prompt contains the three new sections when applicable.
- Ask-user reply → `user_answer` memory → next run injected; near-duplicate question → `suggestedAnswer` on the event; toggle on → auto-answered without pausing (`agent.question.autoanswered` event).
- Strategize-mode run: first narration recorded as `agent.plan`; retrieval used topK 10 / hops 3; agent node seeded.
- No memory/reflection failure can fail a run (every call is void/caught).

Spec deviation (documented): spec §2 "run-node text enriched with reflection learnings" is satisfied differently — learnings become standalone `insight` nodes edged to the agent (Task 6), which the upgraded retrieval (agent-node seeding) surfaces the same way, without re-indexing the run node after reflection. If observed retrieval quality wants the run-node enrichment too, it's a small follow-up in `indexExecution`.

Plan 2 (separate doc) covers: memory tab + CRUD API, suggestion cards + lightbulb badge, PLAN card + auto-answer/prefill rendering in the activity pane, goal field + toggles in the config form.
