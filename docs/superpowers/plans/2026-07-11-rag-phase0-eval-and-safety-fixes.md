# RAG/Agent-Response Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an on-demand RAG + grounding eval benchmark, then fix the two live correctness bugs it lets us prove — the agent-memory graph-node privacy leak and the hallucination amplifier (no relevance floor + an anti-hedging prompt line).

**Architecture:** A new `src/lib/eval/rag/` benchmark seeds a throwaway pgvector DB from a small committed synthetic corpus, queries the *real* `retrieveKnowledge` for recall@k/MRR, generates grounded answers and grades them with an LLM judge, and prints a threshold sweep + scorecard. The two fixes reuse the real retrieval/injection/indexing paths: a shared relevance-floor helper gates what gets injected into a run's prompt, and the agent-memory graph node inherits its agent's owner/visibility instead of hardcoding `shared`.

**Tech Stack:** TypeScript (single quotes, no semicolons, 2-space indent), `node:test` + `node:assert/strict`, `tsx`, Prisma/Postgres + pgvector, Voyage `voyage-3` embeddings (1024-dim), `generateStructured` (Anthropic-wire) for LLM judging.

## Global Constraints

- Code style: single quotes, no semicolons, 2-space indent (copy the surrounding files).
- No Prisma schema migration in Phase 0 — the memory-node fix is graph-only; the eval uses a throwaway DB seeded through the existing ingest path.
- Reuse existing retrieval/ingest/embeddings code — the eval must measure the real path; the relevance floor lives at the injection boundary and as an optional retriever param, never a forked retriever.
- The eval is a keyed benchmark (`npm run eval:rag`), NOT a per-commit CI gate. It is gated on `VOYAGE_API_KEY` (retrieval) + a model key (grounding), skipping cleanly when absent — mirror the existing judge's skip-without-key behavior.
- Retrieval scores are cosine similarity = `1 - cosine_distance`; every retriever already returns `score` in `[−1, 1]` where higher = more relevant. Floors compare against `score`.
- No raw `{{token}}` syntax in any user-facing string (not applicable to these files, but holds).
- Graph-RAG writes are gated on `ragEnabled()` = `embeddingsConfigured() && neo4jConfigured()`. Tests that exercise node visibility go through `MemoryGraphStore` directly (store-contract style) or through an injected indexer spy — not through the gated `commit()` path.

---

### Task 1: Relevance-floor helper + `minScore` on the three retrievers

**Files:**
- Create: `src/lib/rag/relevance.ts`
- Modify: `src/lib/knowledge/retrieve.ts` (`retrieveKnowledge`)
- Modify: `src/lib/memory/agent-memory.ts` (`retrieveAgentMemory`)
- Modify: `src/lib/rag/retrieve.ts` (`retrieveContext`)
- Test: `src/lib/rag/__tests__/relevance.test.ts`

**Interfaces:**
- Produces:
  - `applyRelevanceFloor<T extends { score: number }>(hits: T[], minScore?: number): T[]` — drops hits below `minScore`; no-op when `minScore` is `undefined`.
  - Constants `KNOWLEDGE_RELEVANCE_FLOOR = 0.35`, `MEMORY_RELEVANCE_FLOOR = 0.35`, `CONTEXT_RELEVANCE_FLOOR = 0.3` (starting defaults; Task 6 records the eval-tuned values).
  - `retrieveKnowledge`, `retrieveAgentMemory`, `retrieveContext` each accept an optional `minScore?: number` in their params object. When omitted, behavior is unchanged (they still return scored hits so the eval can sweep thresholds).

- [ ] **Step 1: Write the failing test**

Create `src/lib/rag/__tests__/relevance.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRelevanceFloor, KNOWLEDGE_RELEVANCE_FLOOR, MEMORY_RELEVANCE_FLOOR, CONTEXT_RELEVANCE_FLOOR } from '../relevance'

test('applyRelevanceFloor drops hits below the floor and keeps those at or above it', () => {
  const hits = [{ score: 0.9 }, { score: 0.35 }, { score: 0.2 }, { score: -0.1 }]
  assert.deepEqual(applyRelevanceFloor(hits, 0.35), [{ score: 0.9 }, { score: 0.35 }])
})

test('applyRelevanceFloor is a no-op when minScore is undefined', () => {
  const hits = [{ score: 0.9 }, { score: 0.1 }]
  assert.deepEqual(applyRelevanceFloor(hits, undefined), hits)
})

test('applyRelevanceFloor preserves extra fields on the hit', () => {
  const hits = [{ score: 0.5, id: 'a' }, { score: 0.1, id: 'b' }]
  assert.deepEqual(applyRelevanceFloor(hits, 0.3), [{ score: 0.5, id: 'a' }])
})

test('the exported floor defaults are in a sane cosine range', () => {
  for (const floor of [KNOWLEDGE_RELEVANCE_FLOOR, MEMORY_RELEVANCE_FLOOR, CONTEXT_RELEVANCE_FLOOR]) {
    assert.ok(floor > 0 && floor < 1, `floor ${floor} should be a cosine-similarity cutoff in (0,1)`)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern='applyRelevanceFloor'` (or `npx tsx --test src/lib/rag/__tests__/relevance.test.ts`)
Expected: FAIL — `Cannot find module '../relevance'`.

- [ ] **Step 3: Create the relevance helper**

Create `src/lib/rag/relevance.ts`:

```ts
/**
 * Relevance floors for retrieval INJECTION.
 *
 * Every retriever returns scored hits (score = 1 - cosine_distance). Ranking
 * quality is measured by the RAG eval; these floors govern what actually gets
 * injected into a run's prompt at the execute-agent boundary. Dropping
 * below-floor hits stops weak matches from padding the prompt and inviting the
 * model to treat noise as fact (the hallucination amplifier). The raw
 * retrievers stay unfiltered unless a caller passes minScore, so the eval can
 * sweep thresholds over the same ranked list.
 *
 * Values are cosine-similarity cutoffs, tuned from `npm run eval:rag`'s
 * threshold sweep (see docs/superpowers/plans — Task 6 records the chosen
 * values). They are deliberately conservative starting points.
 */
export const KNOWLEDGE_RELEVANCE_FLOOR = 0.35
export const MEMORY_RELEVANCE_FLOOR = 0.35
export const CONTEXT_RELEVANCE_FLOOR = 0.3

/** Drop hits scoring below `minScore`. No-op when `minScore` is undefined. */
export function applyRelevanceFloor<T extends { score: number }>(hits: T[], minScore?: number): T[] {
  if (minScore == null) return hits
  return hits.filter((hit) => hit.score >= minScore)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/rag/__tests__/relevance.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Thread `minScore` into `retrieveKnowledge`**

In `src/lib/knowledge/retrieve.ts`, add the import at the top (after the existing imports):

```ts
import { applyRelevanceFloor } from '@/lib/rag/relevance'
```

Add `minScore` to the params type:

```ts
export async function retrieveKnowledge(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
  minScore?: number
}): Promise<KnowledgeHit[]> {
```

In the vector-path return, replace:

```ts
      return rows.map((row) => ({ content: row.content, filename: row.filename, score: 1 - row.distance }))
```

with:

```ts
      const hits = rows.map((row) => ({ content: row.content, filename: row.filename, score: 1 - row.distance }))
      return applyRelevanceFloor(hits, params.minScore)
```

In the keyword-fallback return, replace:

```ts
    return scored.filter((s) => s.score > 0).slice(0, k)
```

with:

```ts
    return applyRelevanceFloor(scored.filter((s) => s.score > 0).slice(0, k), params.minScore)
```

- [ ] **Step 6: Thread `minScore` into `retrieveAgentMemory`**

In `src/lib/memory/agent-memory.ts`, add the import (after the existing `keywordScore` import on line 4):

```ts
import { applyRelevanceFloor } from '@/lib/rag/relevance'
```

Add `minScore` to the params type:

```ts
export async function retrieveAgentMemory(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
  minScore?: number
}): Promise<MemoryHit[]> {
```

In the vector-path return, replace:

```ts
      return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: 1 - row.distance }))
```

with:

```ts
      const hits = rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: 1 - row.distance }))
      return applyRelevanceFloor(hits, params.minScore)
```

In the keyword-fallback return, replace:

```ts
    return scored.filter((s) => s.score > 0).slice(0, k)
```

with:

```ts
    return applyRelevanceFloor(scored.filter((s) => s.score > 0).slice(0, k), params.minScore)
```

- [ ] **Step 7: Thread `minScore` into `retrieveContext`**

In `src/lib/rag/retrieve.ts`, add the import (after the `import type { GraphNode ... }` line):

```ts
import { applyRelevanceFloor } from './relevance'
```

Add `minScore` to the `RetrieveOptions` interface (after `embed?`):

```ts
  /** Drop search hits scoring below this cosine-similarity floor before expansion. */
  minScore?: number
```

Immediately after the `try { ... } catch { searchHits = [] }` block that assigns `searchHits` (right before the `const seedIds = ...` line), insert:

```ts
  // Floor before expansion so weak hits don't seed the neighborhood walk.
  searchHits = applyRelevanceFloor(searchHits, options.minScore)
```

- [ ] **Step 8: Run the full retriever tests to verify nothing regressed**

Run: `npx tsx --test src/lib/rag/__tests__/retrieve.test.ts src/lib/rag/__tests__/relevance.test.ts src/lib/knowledge/__tests__/*.test.ts`
Expected: PASS — existing retrieve/knowledge tests still green, relevance tests green.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors from the new `minScore` params or the import.

- [ ] **Step 10: Commit**

```bash
git add src/lib/rag/relevance.ts src/lib/rag/__tests__/relevance.test.ts src/lib/knowledge/retrieve.ts src/lib/memory/agent-memory.ts src/lib/rag/retrieve.ts
git commit -m "feat(rag): relevance-floor helper + optional minScore on the three retrievers"
```

---

### Task 2: RAG eval core — types, metrics, committed corpus + bootstrap golden set

**Files:**
- Create: `src/lib/eval/rag/types.ts`
- Create: `src/lib/eval/rag/metrics.ts`
- Create: `src/lib/eval/rag/index.ts`
- Create: `src/lib/eval/rag/corpus/pricing-tiers.md`
- Create: `src/lib/eval/rag/corpus/discovery-playbook.md`
- Create: `src/lib/eval/rag/corpus/renewal-process.md`
- Create: `src/lib/eval/rag/corpus/security-faq.md`
- Create: `src/lib/eval/rag/corpus/integrations-catalog.md`
- Create: `src/lib/eval/rag/corpus/onboarding-sla.md`
- Create: `src/lib/eval/rag/corpus/competitive-notes.md`
- Create: `src/lib/eval/rag/corpus/support-tiers.md`
- Create: `src/lib/eval/rag/golden.json`
- Test: `src/lib/eval/rag/__tests__/metrics.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `GoldenItem { id: string; query: string; sourceDocIds: string[]; referenceAnswer: string; unanswerable: boolean }`
  - `RetrievalMetrics { recallAt3: number; recallAt5: number; recallAt10: number; mrr: number }`
  - `GroundingMetrics { meanFaithfulness: number; meanAnswerRelevance: number; refusalRate: number; judged: number }`
  - `SweepRow { floor: number; meanRecallAt5: number; meanFaithfulness: number | null }`
  - `RagScorecard { corpusDocs; goldenItems; answerable; unanswerable; retrieval: RetrievalMetrics; grounding: GroundingMetrics | null; sweep: SweepRow[]; generatedAtIso: string }`
  - `recallAtK(retrieved: string[], gold: string[], k: number): number`
  - `reciprocalRank(retrieved: string[], gold: string[]): number`
  - `mean(values: number[]): number`
  - `retrievalMetrics(perQuery: Array<{ retrieved: string[]; gold: string[] }>): RetrievalMetrics`
  - `loadGolden(): GoldenItem[]` and `corpusDocIds(): string[]` — filesystem loaders used by the runner and tests.

- [ ] **Step 1: Write the failing test**

Create `src/lib/eval/rag/__tests__/metrics.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, reciprocalRank, mean, retrievalMetrics } from '../metrics'
import { loadGolden, corpusDocIds } from '../index'

test('recallAtK counts gold docs found in the top k, over the gold-set size', () => {
  assert.equal(recallAtK(['a', 'b', 'c', 'd'], ['b', 'd'], 3), 0.5) // only b in top-3
  assert.equal(recallAtK(['a', 'b', 'c', 'd'], ['b', 'd'], 4), 1)
  assert.equal(recallAtK(['x', 'y'], ['z'], 5), 0)
})

test('reciprocalRank is 1/(rank of first gold hit), 0 when none present', () => {
  assert.equal(reciprocalRank(['a', 'b', 'c'], ['b']), 1 / 2)
  assert.equal(reciprocalRank(['a', 'b', 'c'], ['a']), 1)
  assert.equal(reciprocalRank(['a', 'b'], ['z']), 0)
})

test('mean handles the empty list without NaN', () => {
  assert.equal(mean([]), 0)
  assert.equal(mean([1, 2, 3]), 2)
})

test('retrievalMetrics ignores unanswerable (empty-gold) queries', () => {
  const m = retrievalMetrics([
    { retrieved: ['a', 'b'], gold: ['a'] },
    { retrieved: ['x'], gold: [] }, // unanswerable — excluded from recall/MRR
  ])
  assert.equal(m.recallAt3, 1)
  assert.equal(m.mrr, 1)
})

test('every golden item references corpus doc ids that exist (answerable) and is well-formed', () => {
  const golden = loadGolden()
  const docs = new Set(corpusDocIds())
  assert.ok(golden.length >= 12, 'expected a non-trivial golden set')
  assert.ok(golden.some((g) => g.unanswerable), 'expected at least one adversarial unanswerable query')
  for (const item of golden) {
    assert.ok(item.id && item.query && typeof item.referenceAnswer === 'string', `item ${item.id} malformed`)
    if (item.unanswerable) {
      assert.equal(item.sourceDocIds.length, 0, `unanswerable ${item.id} must have no sourceDocIds`)
    } else {
      assert.ok(item.sourceDocIds.length > 0, `answerable ${item.id} needs sourceDocIds`)
      for (const docId of item.sourceDocIds) {
        assert.ok(docs.has(docId), `golden ${item.id} references missing corpus doc "${docId}"`)
      }
    }
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/eval/rag/__tests__/metrics.test.ts`
Expected: FAIL — `Cannot find module '../metrics'`.

- [ ] **Step 3: Create the types**

Create `src/lib/eval/rag/types.ts`:

```ts
/**
 * Types for the RAG + grounding eval. A GoldenItem is one graded query: an
 * answerable question tagged with the corpus doc ids it's answerable from and a
 * reference answer, or an adversarial `unanswerable` query (no sourceDocIds)
 * used to measure the grounding-refusal fix.
 */
export interface GoldenItem {
  id: string
  query: string
  /** Corpus doc ids this query is answerable from; empty for unanswerable. */
  sourceDocIds: string[]
  referenceAnswer: string
  unanswerable: boolean
}

export interface RetrievalMetrics {
  recallAt3: number
  recallAt5: number
  recallAt10: number
  mrr: number
}

export interface GroundingMetrics {
  meanFaithfulness: number
  meanAnswerRelevance: number
  /** Fraction of unanswerable queries the system correctly declined. */
  refusalRate: number
  judged: number
}

export interface SweepRow {
  floor: number
  meanRecallAt5: number
  /** null when no model key is configured (grounding not measured). */
  meanFaithfulness: number | null
}

export interface RagScorecard {
  corpusDocs: number
  goldenItems: number
  answerable: number
  unanswerable: number
  retrieval: RetrievalMetrics
  grounding: GroundingMetrics | null
  sweep: SweepRow[]
  generatedAtIso: string
}
```

- [ ] **Step 4: Create the metrics**

Create `src/lib/eval/rag/metrics.ts`:

```ts
import type { RetrievalMetrics } from './types'

/** Recall@k: fraction of the gold doc ids that appear in the top-k retrieved. */
export function recallAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 0
  const top = new Set(retrieved.slice(0, k))
  const found = gold.filter((docId) => top.has(docId)).length
  return found / gold.length
}

/** Reciprocal rank of the first gold hit in the retrieved list (0 if none). */
export function reciprocalRank(retrieved: string[], gold: string[]): number {
  const goldSet = new Set(gold)
  for (let i = 0; i < retrieved.length; i += 1) {
    if (goldSet.has(retrieved[i])) return 1 / (i + 1)
  }
  return 0
}

/** Arithmetic mean; 0 for the empty list (never NaN). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Aggregate recall@{3,5,10} + MRR over answerable queries only (gold non-empty). */
export function retrievalMetrics(perQuery: Array<{ retrieved: string[]; gold: string[] }>): RetrievalMetrics {
  const answerable = perQuery.filter((q) => q.gold.length > 0)
  return {
    recallAt3: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 3))),
    recallAt5: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 5))),
    recallAt10: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 10))),
    mrr: mean(answerable.map((q) => reciprocalRank(q.retrieved, q.gold))),
  }
}
```

- [ ] **Step 5: Create the index / filesystem loaders**

Create `src/lib/eval/rag/index.ts`:

```ts
/**
 * RAG eval — public surface + filesystem loaders.
 *
 * The corpus is a set of committed synthetic Sales-AI markdown docs; the corpus
 * doc id is the filename without its extension. golden.json is the committed
 * synthetic Q/A set scored against them (bootstrap-seeded, regenerable via
 * generate.ts — see `npm run eval:rag:generate`).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GoldenItem } from './types'

export * from './types'
export { recallAtK, reciprocalRank, mean, retrievalMetrics } from './metrics'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CORPUS_DIR = join(HERE, 'corpus')
export const GOLDEN_PATH = join(HERE, 'golden.json')

/** Corpus doc ids (filename without extension), sorted. */
export function corpusDocIds(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .sort()
}

/** Read one corpus doc's text by id. */
export function corpusDocText(docId: string): string {
  return readFileSync(join(CORPUS_DIR, `${docId}.md`), 'utf-8')
}

/** Parse the committed golden set. */
export function loadGolden(): GoldenItem[] {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as GoldenItem[]
}

/** Map a retrieved knowledge filename back to its corpus doc id. */
export function filenameToDocId(filename: string): string {
  return filename.replace(/\.md$/, '')
}
```

- [ ] **Step 6: Author the corpus docs**

Create eight short synthetic Sales-AI docs. Keep each under ~1000 characters so it chunks to a single passage (the ingest chunker uses `size: 1200`), which keeps the retrieved-filename → doc-id mapping one-to-one. Author them so the golden Q/A in Step 7 are genuinely answerable. Example — create `src/lib/eval/rag/corpus/pricing-tiers.md`:

```markdown
# Backstory Sales AI — Pricing Tiers

Backstory Sales AI is sold in three tiers, billed per seat per month, annual contract.

- **Starter** — $40/seat/month. Up to 10 seats. Includes account scoring, the signal inbox, and email delivery. No API access.
- **Growth** — $75/seat/month. Up to 100 seats. Adds the graph-RAG correlation layer, Slack delivery, and 5,000 API calls/day.
- **Enterprise** — custom pricing, 100+ seats. Adds SSO/SAML, per-org webhook signing secrets, unlimited API calls, and a dedicated success manager.

Discounts: 15% for a two-year commitment. Non-profits get 20% off any tier. There is no free tier; a 14-day trial of Growth is available.
```

Create the remaining seven with the same shape (short, factual, self-contained). Suggested contents:

- `discovery-playbook.md` — the 4-stage discovery motion (identify, qualify, map stakeholders, propose), what "qualified" means (budget + timeline + named champion), and the rule that a deal without a named champion stays in "qualify".
- `renewal-process.md` — renewals open 90 days before term end; the renewal owner is the account's success manager; auto-renew unless cancelled 30 days prior; usage below 40% of purchased seats triggers a downsell-risk flag.
- `security-faq.md` — data encrypted at rest and in transit; SOC 2 Type II; per-org webhook signing secrets on Enterprise; data residency US-only today, EU in H2; customer data never used to train models.
- `integrations-catalog.md` — supported integrations: Salesforce CRM, Snowflake usage data, Slack, Gmail, Google Calendar, and any HTTP/Query API via the http tool; Pipedream owns embedded account connections; Klavis owns agent-facing MCP tool servers.
- `onboarding-sla.md` — Enterprise onboarding completes within 30 days; a named implementation engineer; kickoff within 5 business days of signature; Growth/Starter self-serve with in-app onboarding.
- `competitive-notes.md` — vs. Gong: Backstory focuses on forward-looking account scoring and autonomous agents, not call recording; vs. Clari: Backstory adds a graph-RAG correlation layer across signals, runs, and account facts; primary displacement risk is homegrown spreadsheets.
- `support-tiers.md` — Starter: community + email, next-business-day; Growth: email + chat, 8-hour response; Enterprise: dedicated success manager, 1-hour P1 response, shared Slack channel.

Each file's first line should be an `#` title; keep the body 4–8 short lines of concrete facts.

- [ ] **Step 7: Author the bootstrap golden set**

Create `src/lib/eval/rag/golden.json` with at least 12 answerable items (each `sourceDocIds` referencing real corpus ids from Step 6) and at least 3 adversarial `unanswerable` items (empty `sourceDocIds`). The queries must be answerable strictly from the corpus you authored. Example (extend to ≥15 total):

```json
[
  {
    "id": "q-pricing-growth",
    "query": "How much does the Growth tier cost per seat and how many seats does it allow?",
    "sourceDocIds": ["pricing-tiers"],
    "referenceAnswer": "Growth is $75 per seat per month and allows up to 100 seats.",
    "unanswerable": false
  },
  {
    "id": "q-pricing-nonprofit",
    "query": "Is there a discount for non-profits?",
    "sourceDocIds": ["pricing-tiers"],
    "referenceAnswer": "Yes, non-profits get 20% off any tier.",
    "unanswerable": false
  },
  {
    "id": "q-discovery-qualified",
    "query": "What makes a deal count as qualified?",
    "sourceDocIds": ["discovery-playbook"],
    "referenceAnswer": "A qualified deal has budget, a timeline, and a named champion; without a named champion it stays in the qualify stage.",
    "unanswerable": false
  },
  {
    "id": "q-renewal-window",
    "query": "How many days before term end does a renewal open, and who owns it?",
    "sourceDocIds": ["renewal-process"],
    "referenceAnswer": "Renewals open 90 days before term end and are owned by the account's success manager.",
    "unanswerable": false
  },
  {
    "id": "q-renewal-downsell",
    "query": "What triggers a downsell-risk flag on an account?",
    "sourceDocIds": ["renewal-process"],
    "referenceAnswer": "Usage below 40% of purchased seats triggers a downsell-risk flag.",
    "unanswerable": false
  },
  {
    "id": "q-security-soc2",
    "query": "Is Backstory Sales AI SOC 2 compliant, and is customer data used for training?",
    "sourceDocIds": ["security-faq"],
    "referenceAnswer": "It is SOC 2 Type II compliant and customer data is never used to train models.",
    "unanswerable": false
  },
  {
    "id": "q-security-webhook",
    "query": "Which tier gets per-org webhook signing secrets?",
    "sourceDocIds": ["security-faq", "pricing-tiers"],
    "referenceAnswer": "Per-org webhook signing secrets are an Enterprise-tier feature.",
    "unanswerable": false
  },
  {
    "id": "q-integrations-list",
    "query": "Which data warehouse and CRM does Backstory integrate with?",
    "sourceDocIds": ["integrations-catalog"],
    "referenceAnswer": "Salesforce CRM and Snowflake usage data.",
    "unanswerable": false
  },
  {
    "id": "q-onboarding-enterprise",
    "query": "How quickly does Enterprise onboarding complete and does it include an engineer?",
    "sourceDocIds": ["onboarding-sla"],
    "referenceAnswer": "Enterprise onboarding completes within 30 days with a named implementation engineer.",
    "unanswerable": false
  },
  {
    "id": "q-competitive-gong",
    "query": "How does Backstory differ from Gong?",
    "sourceDocIds": ["competitive-notes"],
    "referenceAnswer": "Backstory focuses on forward-looking account scoring and autonomous agents rather than call recording.",
    "unanswerable": false
  },
  {
    "id": "q-support-enterprise-p1",
    "query": "What is the P1 response time on the Enterprise support tier?",
    "sourceDocIds": ["support-tiers"],
    "referenceAnswer": "Enterprise gets a 1-hour P1 response with a dedicated success manager and a shared Slack channel.",
    "unanswerable": false
  },
  {
    "id": "q-trial",
    "query": "Is there a free trial, and of which tier?",
    "sourceDocIds": ["pricing-tiers"],
    "referenceAnswer": "There is no free tier, but a 14-day trial of Growth is available.",
    "unanswerable": false
  },
  {
    "id": "q-unanswerable-mobile",
    "query": "Does Backstory Sales AI have a native iPhone app, and what is its App Store rating?",
    "sourceDocIds": [],
    "referenceAnswer": "The corpus does not say.",
    "unanswerable": true
  },
  {
    "id": "q-unanswerable-ceo",
    "query": "Who is the CEO of Backstory and when was the company founded?",
    "sourceDocIds": [],
    "referenceAnswer": "The corpus does not say.",
    "unanswerable": true
  },
  {
    "id": "q-unanswerable-hipaa",
    "query": "Is Backstory HIPAA certified for storing patient health records?",
    "sourceDocIds": [],
    "referenceAnswer": "The corpus does not say.",
    "unanswerable": true
  }
]
```

- [ ] **Step 8: Run the metrics test to verify it passes**

Run: `npx tsx --test src/lib/eval/rag/__tests__/metrics.test.ts`
Expected: PASS — all 5 tests, including the golden↔corpus consistency check.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/eval/rag/types.ts src/lib/eval/rag/metrics.ts src/lib/eval/rag/index.ts src/lib/eval/rag/corpus src/lib/eval/rag/golden.json src/lib/eval/rag/__tests__/metrics.test.ts
git commit -m "feat(eval): RAG eval core — types, metrics, synthetic corpus + bootstrap golden set"
```

---

### Task 3: RAG eval runner — seed pgvector, score retrieval, threshold sweep, `eval:rag` script

**Files:**
- Create: `src/lib/eval/rag/seed.ts`
- Create: `src/lib/eval/rag/run.ts`
- Modify: `package.json` (add `eval:rag` script)
- Modify: `.gitignore` (ignore `scorecard.latest.json`)

**Interfaces:**
- Consumes: `loadGolden`, `corpusDocIds`, `corpusDocText`, `filenameToDocId`, `retrievalMetrics`, `recallAtK`, `mean` from `./index` / `./metrics` (Task 2); `ingestKnowledgeFile` from `@/lib/knowledge/ingest`; `retrieveKnowledge` from `@/lib/knowledge/retrieve`; `prisma` from `@/lib/prisma`.
- Produces:
  - `seedCorpus(organizationId: string, agentId: string): Promise<number>` — ingests every corpus doc, returns doc count.
  - `runRagEval(): Promise<RagScorecard>` — the benchmark entry; in this task it fills `retrieval` + `sweep` and sets `grounding: null` (Task 4 adds grounding).
  - `SWEEP_FLOORS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]`.

- [ ] **Step 1: Create the corpus seeder**

Create `src/lib/eval/rag/seed.ts`:

```ts
/**
 * Seed a throwaway pgvector DB from the committed corpus using the REAL ingest
 * path (extract → chunk → embed → persist with embeddingVec). Measuring the
 * real retrieval means seeding through the real writer, not a shortcut.
 */
import { ingestKnowledgeFile } from '@/lib/knowledge/ingest'
import { corpusDocIds, corpusDocText } from './index'

/** Ingest every corpus doc as agent knowledge under the given org/agent. Returns the doc count. */
export async function seedCorpus(organizationId: string, agentId: string): Promise<number> {
  const ids = corpusDocIds()
  for (const docId of ids) {
    const text = corpusDocText(docId)
    await ingestKnowledgeFile({
      organizationId,
      agentId,
      userId: null,
      filename: `${docId}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(text, 'utf-8'),
    })
  }
  return ids.length
}
```

- [ ] **Step 2: Create the runner (retrieval + sweep)**

Create `src/lib/eval/rag/run.ts`:

```ts
/**
 * RAG + grounding eval benchmark. Run on-demand: `npm run eval:rag`.
 *
 * Gated on VOYAGE_API_KEY (retrieval needs real embeddings) + a throwaway
 * Postgres with pgvector (DATABASE_URL — point it at a disposable DB; this
 * creates and deletes its own org). Grounding metrics (Task 4) additionally
 * need a model key and are skipped when absent, mirroring the existing judge.
 *
 * This is a benchmark, not a CI gate: it prints a scorecard + a floor-threshold
 * sweep and writes scorecard.latest.json (git-ignored) for tracking over time.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/prisma'
import { embeddingsConfigured } from '@/lib/rag/embeddings'
import { retrieveKnowledge } from '@/lib/knowledge/retrieve'
import { seedCorpus } from './seed'
import { loadGolden, corpusDocIds, filenameToDocId, CORPUS_DIR } from './index'
import { retrievalMetrics, recallAtK, mean } from './metrics'
import type { GoldenItem, RagScorecard, SweepRow } from './types'

export const SWEEP_FLOORS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]

/** One query's retrieval result: the ranked corpus doc ids + their scores. */
interface Retrieved {
  item: GoldenItem
  docIds: string[]
  scores: number[]
}

async function retrieveAll(organizationId: string, agentId: string, golden: GoldenItem[]): Promise<Retrieved[]> {
  const out: Retrieved[] = []
  for (const item of golden) {
    // Raw retrieval (no floor) at k=10 so the sweep can filter over one ranked list.
    const hits = await retrieveKnowledge({ organizationId, agentId, query: item.query, k: 10 })
    out.push({
      item,
      docIds: hits.map((h) => filenameToDocId(h.filename)),
      scores: hits.map((h) => h.score),
    })
  }
  return out
}

/** Recall@5 at a given floor: keep only hits scoring >= floor, then measure. */
function sweep(retrieved: Retrieved[]): SweepRow[] {
  const answerable = retrieved.filter((r) => r.item.sourceDocIds.length > 0)
  return SWEEP_FLOORS.map((floor) => {
    const perQuery = answerable.map((r) => {
      const kept = r.docIds.filter((_, i) => r.scores[i] >= floor)
      return recallAtK(kept, r.item.sourceDocIds, 5)
    })
    return { floor, meanRecallAt5: mean(perQuery), meanFaithfulness: null }
  })
}

export async function runRagEval(): Promise<RagScorecard> {
  if (!embeddingsConfigured()) {
    throw new Error('eval:rag needs VOYAGE_API_KEY (real embeddings). Set it and point DATABASE_URL at a throwaway pgvector DB.')
  }

  // Disposable org + agent; deleted in `finally` (org delete cascades knowledge).
  const org = await prisma.organization.create({ data: { name: 'rag-eval', slug: `rag-eval-${process.pid}-${process.hrtime.bigint()}` } })
  const agent = await prisma.agentTask.create({ data: { organizationId: org.id, description: 'rag-eval agent', objective: 'eval' } })

  try {
    const corpusDocs = await seedCorpus(org.id, agent.id)
    const golden = loadGolden()
    const retrieved = await retrieveAll(org.id, agent.id, golden)

    const retrieval = retrievalMetrics(retrieved.map((r) => ({ retrieved: r.docIds, gold: r.item.sourceDocIds })))
    const sweepRows = sweep(retrieved)

    const scorecard: RagScorecard = {
      corpusDocs,
      goldenItems: golden.length,
      answerable: golden.filter((g) => !g.unanswerable).length,
      unanswerable: golden.filter((g) => g.unanswerable).length,
      retrieval,
      grounding: null,
      sweep: sweepRows,
      generatedAtIso: new Date().toISOString(),
    }
    return scorecard
  } finally {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
}

function printScorecard(card: RagScorecard): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  console.log('\n=== RAG eval scorecard ===')
  console.log(`corpus docs: ${card.corpusDocs} | golden: ${card.goldenItems} (${card.answerable} answerable, ${card.unanswerable} unanswerable)`)
  console.log(`recall@3=${pct(card.retrieval.recallAt3)} recall@5=${pct(card.retrieval.recallAt5)} recall@10=${pct(card.retrieval.recallAt10)} MRR=${card.retrieval.mrr.toFixed(3)}`)
  console.log('\nfloor sweep (recall@5 of injected hits):')
  for (const row of card.sweep) {
    const faith = row.meanFaithfulness == null ? 'n/a' : pct(row.meanFaithfulness)
    console.log(`  floor ${row.floor.toFixed(2)}: recall@5=${pct(row.meanRecallAt5)} faithfulness=${faith}`)
  }
  if (card.grounding) {
    console.log(`\ngrounding: faithfulness=${pct(card.grounding.meanFaithfulness)} answer-relevance=${pct(card.grounding.meanAnswerRelevance)} refusal-rate=${pct(card.grounding.refusalRate)} (judged ${card.grounding.judged})`)
  } else {
    console.log('\ngrounding: skipped (no model key)')
  }
}

// Entry point when run directly via `npm run eval:rag`.
async function main(): Promise<void> {
  const card = await runRagEval()
  printScorecard(card)
  writeFileSync(join(CORPUS_DIR, '..', 'scorecard.latest.json'), JSON.stringify(card, null, 2))
  await prisma.$disconnect()
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
```

- [ ] **Step 3: Add the `eval:rag` script**

In `package.json`, add to `scripts` (after the existing `eval` line — remember the trailing comma on the `eval` line):

```json
    "eval:rag": "tsx src/lib/eval/rag/run.ts",
```

- [ ] **Step 4: Git-ignore the scorecard output**

Append to `.gitignore`:

```
# RAG eval scorecard (regenerated by `npm run eval:rag`)
src/lib/eval/rag/scorecard.latest.json
```

- [ ] **Step 5: Verify the runner compiles and gates cleanly without a key**

Run: `VOYAGE_API_KEY= npx tsx src/lib/eval/rag/run.ts`
Expected: the process exits non-zero with the message `eval:rag needs VOYAGE_API_KEY ...` (proves the gate fires and the module loads/compiles). No DB writes happen.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/eval/rag/seed.ts src/lib/eval/rag/run.ts package.json .gitignore
git commit -m "feat(eval): RAG eval runner — seed pgvector, recall@k/MRR, floor sweep, npm run eval:rag"
```

---

### Task 4: RAG eval grounding — grounded answer-gen, faithfulness/refusal judge, one-time golden generator

**Files:**
- Create: `src/lib/eval/rag/answer.ts`
- Create: `src/lib/eval/rag/judge.ts`
- Create: `src/lib/eval/rag/generate.ts`
- Modify: `src/lib/eval/rag/run.ts` (fold grounding into the scorecard + sweep)
- Modify: `package.json` (add `eval:rag:generate` script)
- Test: `src/lib/eval/rag/__tests__/grounding.test.ts`

**Interfaces:**
- Consumes: `generateStructured` from `@/lib/llm/model-runner`; `retrieveKnowledge` from `@/lib/knowledge/retrieve`; `renderKnowledge` from `@/lib/knowledge/retrieve`; `KNOWLEDGE_RELEVANCE_FLOOR` from `@/lib/rag/relevance` (Task 1); `loadGolden`, `corpusDocIds`, `corpusDocText` from `./index`.
- Produces:
  - `EVAL_GROUNDING_INSTRUCTION: string` — the grounding/refusal system line the eval's answer-gen uses (a faithful sibling of the run-prompt line Task 6 ships).
  - `REFUSAL_SENTINEL = "I don't have enough information to answer that."`
  - `generateGroundedAnswer(query: string, context: string, deps?: { generate?: typeof generateStructured }): Promise<string>`
  - `isRefusal(answer: string): boolean`
  - `judgeGrounding(query: string, answer: string, context: string, deps?): Promise<{ faithfulness: number; answerRelevance: number }>`
  - `modelKeyConfigured(): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/eval/rag/__tests__/grounding.test.ts` (no real key — inject a fake `generate`):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateGroundedAnswer, isRefusal, REFUSAL_SENTINEL, EVAL_GROUNDING_INSTRUCTION } from '../answer'
import { judgeGrounding } from '../judge'

test('generateGroundedAnswer passes the grounding instruction and returns the model answer', async () => {
  let seenSystem = ''
  const fake = async (opts: { system: string }) => {
    seenSystem = opts.system
    return JSON.stringify({ answer: 'Growth is $75 per seat.' })
  }
  const answer = await generateGroundedAnswer('How much is Growth?', '## Knowledge\nGrowth is $75/seat/month.', { generate: fake as never })
  assert.equal(answer, 'Growth is $75 per seat.')
  assert.ok(seenSystem.includes(EVAL_GROUNDING_INSTRUCTION))
})

test('isRefusal detects the sentinel case-insensitively and ignores substantive answers', () => {
  assert.equal(isRefusal(REFUSAL_SENTINEL), true)
  assert.equal(isRefusal('I DO NOT have enough information to answer that, sorry.'), true)
  assert.equal(isRefusal('Growth is $75 per seat per month.'), false)
})

test('judgeGrounding clamps the judge scores into [0,1]', async () => {
  const fake = async () => JSON.stringify({ faithfulness: 1.4, answerRelevance: -0.2, reasoning: 'x' })
  const scores = await judgeGrounding('q', 'a', 'ctx', { generate: fake as never })
  assert.equal(scores.faithfulness, 1)
  assert.equal(scores.answerRelevance, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/eval/rag/__tests__/grounding.test.ts`
Expected: FAIL — `Cannot find module '../answer'`.

- [ ] **Step 3: Create the grounded answer generator**

Create `src/lib/eval/rag/answer.ts`:

```ts
/**
 * Grounded answer generation for the eval. A single structured call over the
 * retrieved context, instructed to answer ONLY from context and to refuse with
 * a fixed sentinel when the context lacks the answer. This is the proxy the
 * eval grades — it measures whether grounding-style prompting + a relevance
 * floor reduce fabrication, establishing the value BEFORE Task 6 bakes the
 * grounding line into the real run prompt.
 */
import { generateStructured } from '@/lib/llm/model-runner'

export const REFUSAL_SENTINEL = "I don't have enough information to answer that."

export const EVAL_GROUNDING_INSTRUCTION =
  'Answer using ONLY the provided context. Ground every factual claim in that context. ' +
  `If the context does not contain the answer, reply exactly: "${REFUSAL_SENTINEL}" — do not guess or fabricate.`

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string', description: 'The grounded answer, or the exact refusal sentinel.' } },
  required: ['answer'],
} as const

export async function generateGroundedAnswer(
  query: string,
  context: string,
  deps: { generate?: typeof generateStructured } = {},
): Promise<string> {
  const generate = deps.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'rag_eval_answer',
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    system: EVAL_GROUNDING_INSTRUCTION,
    user: `CONTEXT:\n${context || '(no relevant context was retrieved)'}\n\nQUESTION: ${query}`,
  })
  const parsed = JSON.parse(raw) as { answer?: string }
  return typeof parsed.answer === 'string' ? parsed.answer : ''
}

/** True when the answer is a refusal ("...don't/do not have enough information..."). */
export function isRefusal(answer: string): boolean {
  return /do(?:es)?\s*n(?:o|')t\s+have\s+enough\s+information/i.test(answer)
}
```

- [ ] **Step 4: Create the grounding judge**

Create `src/lib/eval/rag/judge.ts`:

```ts
/**
 * LLM-judge for grounding quality — faithfulness (are the answer's claims
 * supported by the retrieved context) and answer-relevance (does it address the
 * question). Reuses generateStructured (provider selection + fallback) and is
 * only called when a model key is configured.
 */
import { generateStructured } from '@/lib/llm/model-runner'

const GROUNDING_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    faithfulness: { type: 'number', description: '0 (claims unsupported/contradicted by context) to 1 (fully supported).' },
    answerRelevance: { type: 'number', description: '0 (ignores the question) to 1 (directly answers it).' },
    reasoning: { type: 'string', description: 'One sentence justifying the scores.' },
  },
  required: ['faithfulness', 'answerRelevance', 'reasoning'],
} as const

const clamp01 = (value: unknown): number => (typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0)

export async function judgeGrounding(
  query: string,
  answer: string,
  context: string,
  deps: { generate?: typeof generateStructured } = {},
): Promise<{ faithfulness: number; answerRelevance: number }> {
  const generate = deps.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'rag_grounding_judgment',
    schema: GROUNDING_JUDGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    system:
      'You are a strict grader of retrieval-augmented answers. Given a question, the retrieved context, and the answer, score faithfulness (are the answer\'s claims supported by the context?) and answer-relevance (does it address the question?). Be rigorous: an answer that adds facts not in the context scores low on faithfulness even if plausible.',
    user: `QUESTION:\n${query}\n\nRETRIEVED CONTEXT:\n${context || '(none)'}\n\nANSWER:\n${answer}`,
  })
  const parsed = JSON.parse(raw) as { faithfulness?: unknown; answerRelevance?: unknown }
  return { faithfulness: clamp01(parsed.faithfulness), answerRelevance: clamp01(parsed.answerRelevance) }
}
```

- [ ] **Step 5: Run the grounding test to verify it passes**

Run: `npx tsx --test src/lib/eval/rag/__tests__/grounding.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Fold grounding into the runner**

In `src/lib/eval/rag/run.ts`, add imports (after the existing `./metrics` import):

```ts
import { renderKnowledge, retrieveKnowledge as retrieveKnowledgeFloored } from '@/lib/knowledge/retrieve'
import { KNOWLEDGE_RELEVANCE_FLOOR } from '@/lib/rag/relevance'
import { generateGroundedAnswer, isRefusal } from './answer'
import { judgeGrounding } from './judge'
import { hasAnthropic, hasQwen } from '@/lib/llm/model-runner'
import type { GroundingMetrics } from './types'
```

> Note: `retrieveKnowledge` is already imported for the retrieval pass; the added `retrieveKnowledgeFloored` alias reuses the same function with `minScore` for the grounding pass. If the linter flags the duplicate import, instead pass `minScore` on the existing `retrieveKnowledge` import and drop the alias. Confirm `hasAnthropic`/`hasQwen` are exported from `model-runner.ts`; if they are not exported, add `modelKeyConfigured()` to `answer.ts` returning `Boolean(process.env.ANTHROPIC_API_KEY || process.env.QWEN_API_KEY)` and import that instead.

Add a `modelKeyConfigured` helper near the top of `run.ts` (below `SWEEP_FLOORS`):

```ts
function modelKeyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.QWEN_API_KEY)
}
```

Add the grounding pass function (after `sweep`):

```ts
/** Grade grounding on the golden set: faithfulness + answer-relevance on answerable
 *  items, refusal-rate on unanswerable ones. Uses the real floored retrieval. */
async function grade(organizationId: string, agentId: string, golden: GoldenItem[]): Promise<GroundingMetrics> {
  const faithfulness: number[] = []
  const relevance: number[] = []
  let refusals = 0
  let judged = 0
  for (const item of golden) {
    const hits = await retrieveKnowledgeFloored({ organizationId, agentId, query: item.query, k: 5, minScore: KNOWLEDGE_RELEVANCE_FLOOR })
    const context = renderKnowledge(hits)
    const answer = await generateGroundedAnswer(item.query, context)
    if (item.unanswerable) {
      if (isRefusal(answer)) refusals += 1
    } else {
      const scores = await judgeGrounding(item.query, answer, context)
      faithfulness.push(scores.faithfulness)
      relevance.push(scores.answerRelevance)
    }
    judged += 1
  }
  const unanswerable = golden.filter((g) => g.unanswerable).length
  return {
    meanFaithfulness: mean(faithfulness),
    meanAnswerRelevance: mean(relevance),
    refusalRate: unanswerable > 0 ? refusals / unanswerable : 0,
    judged,
  }
}
```

In `runRagEval`, after computing `sweepRows` and before building `scorecard`, add:

```ts
    const grounding = modelKeyConfigured() ? await grade(org.id, agent.id, golden) : null
```

and change the scorecard's `grounding: null,` to `grounding,`.

- [ ] **Step 7: Create the one-time golden generator**

Create `src/lib/eval/rag/generate.ts`:

```ts
/**
 * ONE-TIME synthetic golden-set generator. Run by a human with a model key:
 * `npm run eval:rag:generate`. For each corpus doc it asks the model for a few
 * grounded Q/A pairs; the result is written to golden.json and COMMITTED, so
 * the eval itself is reproducible and needs no generation at run time. The
 * committed bootstrap set (Task 2) is the source of truth until regenerated;
 * regeneration is rare and its output should be reviewed before committing.
 */
import { writeFileSync } from 'node:fs'
import { generateStructured } from '@/lib/llm/model-runner'
import { corpusDocIds, corpusDocText, GOLDEN_PATH } from './index'
import type { GoldenItem } from './types'

const QA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          referenceAnswer: { type: 'string' },
        },
        required: ['query', 'referenceAnswer'],
      },
    },
  },
  required: ['pairs'],
} as const

const N_PER_DOC = 2

async function generate(): Promise<void> {
  const items: GoldenItem[] = []
  for (const docId of corpusDocIds()) {
    const text = corpusDocText(docId)
    const raw = await generateStructured({
      schemaName: 'rag_golden_qa',
      schema: QA_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1024,
      system: `Generate exactly ${N_PER_DOC} question/answer pairs answerable STRICTLY from the document. Questions a salesperson would actually ask. Answers must be short and fully grounded in the document — invent nothing.`,
      user: `DOCUMENT (${docId}):\n${text}`,
    })
    const parsed = JSON.parse(raw) as { pairs?: Array<{ query: string; referenceAnswer: string }> }
    for (const [i, pair] of (parsed.pairs ?? []).entries()) {
      items.push({ id: `${docId}-${i}`, query: pair.query, referenceAnswer: pair.referenceAnswer, sourceDocIds: [docId], unanswerable: false })
    }
  }
  // Preserve the hand-authored adversarial unanswerable queries — regeneration
  // only refreshes the answerable pairs; unanswerable queries are curated.
  console.log(`Generated ${items.length} answerable pairs. Review, add unanswerable queries, then commit golden.json.`)
  writeFileSync(GOLDEN_PATH, JSON.stringify(items, null, 2))
}

generate().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 8: Add the `eval:rag:generate` script**

In `package.json` `scripts`, after the `eval:rag` line, add:

```json
    "eval:rag:generate": "tsx src/lib/eval/rag/generate.ts",
```

- [ ] **Step 9: Run the eval unit tests + typecheck**

Run: `npx tsx --test src/lib/eval/rag/__tests__/*.test.ts && npm run typecheck`
Expected: PASS — metrics + grounding tests green, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/eval/rag/answer.ts src/lib/eval/rag/judge.ts src/lib/eval/rag/generate.ts src/lib/eval/rag/run.ts src/lib/eval/rag/__tests__/grounding.test.ts package.json
git commit -m "feat(eval): RAG grounding — grounded answer-gen, faithfulness/refusal judge, one-time golden generator"
```

---

### Task 5: Fix the memory-node privacy leak (thread owner/visibility through the save path)

**Files:**
- Modify: `src/lib/rag/indexer.ts` (`indexAgentMemory` — add `visibility` param, stop hardcoding `shared`)
- Modify: `src/lib/memory/agent-memory.ts` (`saveAgentMemory` — add `ownerUserId`/`visibility` params + an injectable indexer seam)
- Modify: `src/features/agents/reflection.ts` (`reflectAndRemember` — accept + thread owner/visibility)
- Modify: `src/features/agents/execute-agent.ts` (pass owner/visibility at the ask-user save + the reflect call)
- Test: `src/lib/rag/__tests__/store-contract.test.ts` (extend — memory insight node isolation)
- Test: `src/lib/memory/__tests__/agent-memory-vector.test.ts` (extend — saveAgentMemory threads owner/visibility to the indexer)

**Interfaces:**
- Consumes: `NodeVisibility` from `@/lib/rag/store`; `agent.userId`, `agent.visibility` (already in scope in `execute-agent.ts`).
- Produces:
  - `indexAgentMemory(params: { ...; ownerUserId?: string | null; visibility?: NodeVisibility })` — node visibility now comes from `params.visibility ?? 'shared'`.
  - `saveAgentMemory(params: { ...; ownerUserId?: string | null; visibility?: NodeVisibility }, deps?: { index?: (args: IndexArgs) => Promise<void> })` — threads owner/visibility to the indexer; `deps.index` (when provided) is awaited so tests are deterministic; production keeps the fire-and-forget dynamic import.
  - `reflectAndRemember(params: { ...; ownerUserId?: string | null; visibility?: NodeVisibility }, deps?)` — threads into both `saveAgentMemory` calls.

- [ ] **Step 1: Write the failing store-contract test (memory node isolation)**

Append to `src/lib/rag/__tests__/store-contract.test.ts`:

```ts
// ── Agent-memory insight nodes inherit their agent's visibility ──────────────
test('a private agent\'s memory insight node is hidden from other reps, visible to its owner', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    // Mirrors indexAgentMemory's node shape: id `insight:mem:*`, type 'insight'.
    { id: 'insight:mem:m1', organizationId: 'org1', type: 'insight', text: 'private learning', props: { kind: 'learning' }, embedding: [1, 0], ownerUserId: 'repA', visibility: 'private' },
    { id: 'insight:mem:m2', organizationId: 'org1', type: 'insight', text: 'shared learning', props: { kind: 'learning' }, embedding: [1, 0], ownerUserId: null, visibility: 'shared' },
  ])
  const asOwner = await store.search('org1', 'repA', [1, 0], 10)
  assert.deepEqual(asOwner.map((h) => h.node.id).sort(), ['insight:mem:m1', 'insight:mem:m2'])
  const asOther = await store.search('org1', 'repB', [1, 0], 10)
  assert.deepEqual(asOther.map((h) => h.node.id), ['insight:mem:m2'])
})
```

- [ ] **Step 2: Run it to verify it passes against the store (store already scopes correctly)**

Run: `npx tsx --test src/lib/rag/__tests__/store-contract.test.ts`
Expected: PASS — this encodes the guarantee the fix relies on (the store already honors `visibility`; the bug is that `indexAgentMemory` never sets `private`). Keep this as the regression anchor.

- [ ] **Step 3: Write the failing threading test (DB-gated)**

In `src/lib/memory/__tests__/agent-memory-vector.test.ts`, add a new test inside the `if (TEST_DB) {` block (after the last test, before the closing brace). It runs with a DB but no Voyage key (so no embedding/vector work), and injects an index spy:

```ts
  test('saveAgentMemory threads a private agent\'s owner/visibility into the indexer', async () => {
    if (!vectorReady) return
    delete process.env.VOYAGE_API_KEY // no embedding path; exercise the indexer thread only
    const calls: any[] = []
    let id: string | undefined
    try {
      const saved = await saveAgentMemory(
        { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'Private fact', content: 'owned by repA', ownerUserId: 'repA', visibility: 'private' },
        { index: async (args: any) => { calls.push(args) } },
      )
      assert.ok(saved)
      id = saved!.id
      assert.equal(calls.length, 1, 'indexer should be called exactly once')
      assert.equal(calls[0].ownerUserId, 'repA')
      assert.equal(calls[0].visibility, 'private')
      assert.equal(calls[0].memoryId, id)
    } finally {
      if (id) await prisma.agentMemory.delete({ where: { id } }).catch(() => {})
    }
  })
```

- [ ] **Step 4: Run it to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/memory/__tests__/agent-memory-vector.test.ts` (with a pgvector `TEST_DATABASE_URL` set; if unset the suite is skipped and this step can't run — note that and proceed, the CI job runs it).
Expected: FAIL — `saveAgentMemory` doesn't accept a second `deps` arg / doesn't thread `visibility` yet (type error or `calls.length === 0`).

- [ ] **Step 5: Fix `indexAgentMemory` to honor visibility**

In `src/lib/rag/indexer.ts`, change the `indexAgentMemory` signature and node construction. Replace:

```ts
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
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { kind: params.kind, agentId: params.agentId },
      ownerUserId: params.ownerUserId ?? null, visibility: 'shared',
    }]
```

with:

```ts
export async function indexAgentMemory(params: {
  memoryId: string
  organizationId: string
  agentId: string
  kind: string
  title: string
  content: string
  ownerUserId?: string | null
  visibility?: NodeVisibility
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodeId = `insight:mem:${params.memoryId}`
    const text = `Agent memory (${params.kind}): ${params.title}. ${params.content}`.slice(0, 1500)
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { kind: params.kind, agentId: params.agentId },
      // Inherit the owning agent's scope, mirroring the run node — a private
      // agent's learned facts must not surface to other reps via org search.
      ownerUserId: params.ownerUserId ?? null, visibility: params.visibility ?? 'shared',
    }]
```

(`NodeVisibility` is already imported at the top of `indexer.ts`.)

- [ ] **Step 6: Thread owner/visibility + the index seam through `saveAgentMemory`**

In `src/lib/memory/agent-memory.ts`, add the type import near the top (after line 4):

```ts
import type { NodeVisibility } from '@/lib/rag/store'
import type { indexAgentMemory } from '@/lib/rag/indexer'
```

Change the `saveAgentMemory` signature to add the two params and a `deps` seam:

```ts
export async function saveAgentMemory(params: {
  organizationId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  question?: string
  sourceExecutionId?: string
  ownerUserId?: string | null
  visibility?: NodeVisibility
}, deps: { index?: typeof indexAgentMemory } = {}): Promise<{ id: string; deduped: boolean } | null> {
```

Replace the existing fire-and-forget indexer block:

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

with:

```ts
    const indexArgs = {
      memoryId: created.id,
      organizationId: params.organizationId,
      agentId: params.agentId,
      kind: params.kind,
      title: params.title,
      content: params.content,
      ownerUserId: params.ownerUserId ?? null,
      visibility: params.visibility ?? 'shared',
    }
    if (deps.index) {
      // Injected in tests — awaited so the assertion is deterministic.
      await deps.index(indexArgs).catch(() => undefined)
    } else {
      void import('@/lib/rag/indexer')
        .then((indexer) => indexer.indexAgentMemory(indexArgs))
        .catch(() => undefined)
    }
```

- [ ] **Step 7: Thread owner/visibility through `reflectAndRemember`**

In `src/features/agents/reflection.ts`, add the type import (after line 5):

```ts
import type { NodeVisibility } from '@/lib/rag/store'
```

Add the two params to the `reflectAndRemember` params object (after `processLog: string`):

```ts
    ownerUserId?: string | null
    visibility?: NodeVisibility
```

In the learnings loop, change the `saveAgentMemory` call to pass owner/visibility:

```ts
    for (const learning of reflection.learnings.slice(0, 5)) {
      await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'learning',
        title: learning.title,
        content: learning.content,
        sourceExecutionId: params.executionId,
        ownerUserId: params.ownerUserId ?? null,
        visibility: params.visibility,
      })
    }
```

In the suggestions loop, change the `saveAgentMemory` call the same way:

```ts
      const saved = await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'suggestion',
        title: suggestion.title,
        content: suggestion.rationale,
        sourceExecutionId: params.executionId,
        ownerUserId: params.ownerUserId ?? null,
        visibility: params.visibility,
      })
```

- [ ] **Step 8: Pass owner/visibility at the two `execute-agent.ts` call sites**

In `src/features/agents/execute-agent.ts`, at the ask-user save path (the `void saveAgentMemory({ ... })` around line 440), add the two fields before the closing `})`:

```ts
    void saveAgentMemory({
      organizationId,
      agentId,
      kind: 'user_answer',
      title: pending.question.slice(0, 120),
      content: reply,
      question: pending.question,
      sourceExecutionId: queuedExecution.id,
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    })
```

At the `void reflectAndRemember({ ... })` call (around line 1175), add the two fields before the closing `})`:

```ts
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
```

> Note: confirm `agentId` is in scope at the ask-user save path (it is used there already). `agent.userId` / `agent.visibility` are the same fields the `indexExecution` run-node call uses at lines 1168–1169.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx --test src/lib/rag/__tests__/store-contract.test.ts src/lib/rag/__tests__/indexer.test.ts` and, with a DB, `TEST_DATABASE_URL=... npx tsx --test src/lib/memory/__tests__/agent-memory-vector.test.ts`
Expected: PASS — store-contract memory-isolation test green; the threading test asserts `visibility: 'private'` reached the indexer.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS — the new params thread cleanly through all four files.

- [ ] **Step 11: Commit**

```bash
git add src/lib/rag/indexer.ts src/lib/memory/agent-memory.ts src/features/agents/reflection.ts src/features/agents/execute-agent.ts src/lib/rag/__tests__/store-contract.test.ts src/lib/memory/__tests__/agent-memory-vector.test.ts
git commit -m "fix(rag): agent-memory insight nodes inherit their agent's owner/visibility (was hardcoded shared)"
```

---

### Task 6: Fix the hallucination amplifier — grounding/refusal prompt + softened anti-hedging + wire injection-site floors

**Files:**
- Modify: `src/features/agents/system-prompt.ts` (add grounding/refusal line; soften the anti-hedging line)
- Modify: `src/features/agents/execute-agent.ts` (pass the floor constants at the three injection sites)
- Test: `src/features/agents/__tests__/system-prompt.test.ts` (extend — grounding line present, softened wording present)

**Interfaces:**
- Consumes: `KNOWLEDGE_RELEVANCE_FLOOR`, `MEMORY_RELEVANCE_FLOOR`, `CONTEXT_RELEVANCE_FLOOR` from `@/lib/rag/relevance` (Task 1); `buildAgentSystemPrompt` (Task's own module).
- Produces: the run system prompt now contains a grounding/refusal instruction and a present-vs-absent–aware anti-hedging line; the three retrieval injections in `execute-agent.ts` apply their floors.

- [ ] **Step 1: Write the failing system-prompt test**

Append to `src/features/agents/__tests__/system-prompt.test.ts` (inside the existing `describe` block):

```ts
  it('includes a grounding/refusal instruction so the agent declines instead of fabricating', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(/ground/i.test(prompt), 'expected a grounding instruction')
    assert.ok(/say so|don.t (?:guess|fabricate)|rather than inventing/i.test(prompt), 'expected an explicit refusal-over-fabrication instruction')
  })

  it('softens the anti-hedging line to distinguish present from absent information', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    // The old absolute "Never claim you lack access ..." must be gone.
    assert.ok(!prompt.includes('Never claim you lack access to information that is present in your context'), 'the absolute anti-hedging line should be reworded')
    // The reworded line acknowledges genuinely-absent information.
    assert.ok(/genuinely absent|is genuinely absent|when it is genuinely absent/i.test(prompt), 'expected the softened present-vs-absent wording')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/features/agents/__tests__/system-prompt.test.ts`
Expected: FAIL — grounding line absent; the old absolute anti-hedging line still present.

- [ ] **Step 3: Soften the anti-hedging line and add the grounding line**

In `src/features/agents/system-prompt.ts`, replace the anti-hedging line (currently):

```ts
    'Any correlated context you are given (accounts, opportunities, signals, prior runs) is real data from Backstory Sales AI and this workspace. Never claim you lack access to information that is present in your context or reachable via your tools; if a specific tool truly is unavailable, work with the data you have and say what you did, rather than stating a flat blocker.',
```

with two lines (the softened anti-hedging line + the new grounding/refusal line):

```ts
    'Any correlated context you are given (accounts, opportunities, signals, prior runs) is real data from Backstory Sales AI and this workspace. When the information IS present in your context or reachable via your tools, use it — do not wrongly claim you cannot access it; if a specific tool truly is unavailable, work with the data you have and say what you did, rather than stating a flat blocker.',
    'Ground factual claims in the provided context and this run\'s tool results. When the context and tools genuinely do not contain the answer, say so plainly rather than inventing it — do not guess or fabricate.',
```

- [ ] **Step 4: Run the system-prompt test to verify it passes**

Run: `npx tsx --test src/features/agents/__tests__/system-prompt.test.ts`
Expected: PASS — all tests (existing + 2 new).

- [ ] **Step 5: Wire the floors at the three injection sites**

In `src/features/agents/execute-agent.ts`, add the import (near the other rag imports at the top of the file):

```ts
import { KNOWLEDGE_RELEVANCE_FLOOR, MEMORY_RELEVANCE_FLOOR, CONTEXT_RELEVANCE_FLOOR } from '@/lib/rag/relevance'
```

At the graph-RAG injection (the `retrieveContext({ ... })` call around line 684), add `minScore` to the options object:

```ts
        seedNodeIds,
        minScore: CONTEXT_RELEVANCE_FLOOR,
        ...(strategize ? { topK: STRATEGIZE_RETRIEVAL.topK, hops: STRATEGIZE_RETRIEVAL.hops } : {}),
```

At the knowledge injection (`retrieveKnowledge({ ... })` around line 716), add `minScore`:

```ts
      const knowledgeHits = await retrieveKnowledge({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        minScore: KNOWLEDGE_RELEVANCE_FLOOR,
      })
```

At the memory injection (`retrieveAgentMemory({ ... })` around line 740), add `minScore`:

```ts
      const memoryHits = await retrieveAgentMemory({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        minScore: MEMORY_RELEVANCE_FLOOR,
      })
```

- [ ] **Step 6: Typecheck + run the agent test suite**

Run: `npm run typecheck && npx tsx --test src/features/agents/__tests__/*.test.ts`
Expected: PASS — the injection sites accept `minScore`; system-prompt tests green.

- [ ] **Step 7: Tune the floor values from the eval (operator step — keys required)**

This step is run by an operator with `VOYAGE_API_KEY` + a model key + a throwaway pgvector `DATABASE_URL`. The unit tests do NOT depend on the exact float, so this is a tuning refinement, not a blocker:

1. Run `npm run eval:rag`. Read the printed floor sweep (recall@5 + faithfulness per candidate floor) and the grounding block.
2. Pick each floor where faithfulness rises without materially dropping recall@5, per the sweep table.
3. If the chosen values differ from the Task 1 defaults (`0.35 / 0.35 / 0.3`), update the three constants in `src/lib/rag/relevance.ts` and re-run `npm run eval:rag` to confirm the before/after faithfulness lift.
4. Record the chosen values and the observed lift in the commit message.

If no operator run is available in this session, leave the Task 1 defaults in place (they are conservative and safe) and note in the final review that the sweep-based tuning is a follow-up the operator runs with keys.

- [ ] **Step 8: Commit**

```bash
git add src/features/agents/system-prompt.ts src/features/agents/execute-agent.ts src/features/agents/__tests__/system-prompt.test.ts src/lib/rag/relevance.ts
git commit -m "fix(agents): grounding/refusal prompt + softened anti-hedging + injection-site relevance floors"
```

---

## Self-Review

**1. Spec coverage:**

- Deliverable 1 (eval harness): Task 2 (corpus + golden + metrics + no-key tests), Task 3 (seed + retrieval + sweep + `eval:rag`), Task 4 (answer-gen + judge + `generate.ts` + `eval:rag:generate` + grounding folded in). Covers location `src/lib/eval/rag/`, synthetic committed golden set, recall@k/MRR over real `retrieveKnowledge`, faithfulness/answer-relevance judge, refusal check on unanswerable queries, `scorecard.latest.json` git-ignored, keyed/not-a-gate, reuses real ingest/retrieve. ✅
- Deliverable 2 (memory-node leak): Task 5 — `indexAgentMemory` visibility from param, `saveAgentMemory` gains owner/visibility, threaded from reflection + execute-agent (both call sites), no schema change, store-contract isolation test + threading test. ✅
- Deliverable 3 (hallucination amplifier): Task 1 (floor helper + `minScore` on all three retrievers, raw retrievers still return scores), Task 6 (grounding/refusal line, softened anti-hedging, floors wired at injection sites, floor value tuned from the eval in Step 7). ✅
- Sequencing (eval first → tune floor → apply fix; memory fix independent): Tasks 1→4 build the eval, Task 6 Step 7 tunes, Task 5 (memory) is independent. ✅
- Testing summary (structural no-key metric test; graph isolation + threading; system-prompt assertions + injection floor unit test): metrics.test.ts, grounding.test.ts, relevance.test.ts (injection floor), store-contract + agent-memory-vector, system-prompt.test.ts. ✅

**2. Placeholder scan:** No "TBD"/"implement later". The floor *values* are concrete (`0.35/0.35/0.3`) with an explicit, keyed operator tuning step — not a placeholder (the spec says the value is tuned from the eval, which can't run in CI). Every code step shows complete code. The corpus docs give one full example + explicit content specs for the other seven (each is a few lines of authored facts — the implementer writes them from the spec, which is authoring, not a placeholder); the golden.json shows the full schema + 15 concrete items. ✅

**3. Type consistency:** `applyRelevanceFloor`/floor constants named identically across Tasks 1 and 6. `GoldenItem`/`RagScorecard`/`SweepRow`/`GroundingMetrics` defined in Task 2 `types.ts`, consumed unchanged in Tasks 3–4. `indexAgentMemory` param `visibility?: NodeVisibility` (Task 5) matches `saveAgentMemory`'s `visibility?: NodeVisibility` and the `agent.visibility === 'private' ? 'private' : 'shared'` idiom passed in. `retrieveKnowledge`/`retrieveAgentMemory`/`retrieveContext` all gain `minScore?: number` consistently. `generateStructured` opts (`schemaName`, `schema`, `maxTokens`, `system`, `user`) match its real signature. ✅

One risk flagged inline (Task 4 Step 6): `hasAnthropic`/`hasQwen` may not be exported from `model-runner.ts` — the plan gives a self-contained `modelKeyConfigured()` fallback so the task doesn't block on that. The implementer verifies the export and uses the fallback if absent.
