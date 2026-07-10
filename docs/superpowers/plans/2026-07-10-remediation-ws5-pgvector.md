# Remediation WS-R5: pgvector Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Knowledge and agent-memory retrieval stop silently degrading past 500 rows: embeddings move from JSON columns + in-memory cosine scans (hard `take: 500` caps that drop relevance arbitrarily) to pgvector columns with database-side cosine ranking over ALL of an org's rows.

**Architecture:** One migration enables the `vector` extension and adds `embeddingVec vector(1024)` (Prisma `Unsupported`) alongside the existing `embedding Json` columns on `KnowledgeChunk` and `AgentMemory`, backfills from the JSON arrays (dimension-guarded), and adds HNSW cosine indexes. Retrieval (`retrieveKnowledge`, `retrieveAgentMemory`) and the memory-dedup check switch to `$queryRaw` cosine-distance queries (org/agent-filtered, `LIMIT k`) — no more `take: 500` + app-side sort. Write paths (`ingestKnowledgeFile`, `saveAgentMemory`) write the vector via `$executeRaw` immediately after the Prisma insert. The legacy JSON columns stay for this deploy (old serverless instances still write them during the deploy window) and are dropped in a later cleanup — tracked, not silent. The keyword fallback (embeddings unconfigured) is preserved unchanged. The truncating `cosine` in knowledge/retrieve.ts is deleted; the one remaining in-memory implementation (`cosineSimilarity` in rag/embeddings.ts, strict) serves `bestAnswerMatch` and the Neo4j fallback.

**Tech Stack:** pgvector 0.8 (`vector(1024)`, `<=>` cosine distance, HNSW), Prisma 6 `Unsupported` columns + `$queryRaw`/`$executeRaw`, Voyage `voyage-3` embeddings (EMBEDDING_DIM = 1024), node:test.

**Infrastructure prerequisites (Task 1 — these gate everything):**
- Local: Homebrew Postgres 18.4 lacks pgvector; `brew install pgvector` (0.8.5, bottled, builds against postgresql@18) is required — a dev-machine change, noted to the user.
- CI: both jobs' service image changes `postgres:16` → `pgvector/pgvector:pg16` (official drop-in image) or CI's migrate-from-zero + DB suite fail on `CREATE EXTENSION`.
- Prod: Supabase whitelists the `vector` extension; `CREATE EXTENSION IF NOT EXISTS vector` in the migration works via DIRECT_URL (5432) at deploy time.

**Scope Note:** Dropping the legacy `embedding Json` columns is deliberately deferred (deploy-window safety: the previous deployment's instances write JSON until traffic flips) — recorded as tracked debt in ARCHITECTURE.md, to ride along with a future migration. Neo4j-side embeddings are untouched. The suggestion-dedup similarity threshold and injection limits keep their current values.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- ONE schema migration. `vector(1024)` dimension comes from `EMBEDDING_DIM` (rag/embeddings.ts) — if `VOYAGE_EMBED_MODEL` is ever overridden to a different-dim model, writes must fail loudly (dimension mismatch surfaces as a Postgres error), and the backfill must skip rows whose stored array length ≠ 1024 (`jsonb_array_length` guard).
- Raw SQL only for vector reads/writes; everything else stays on the (guarded) Prisma client. Raw queries MUST carry `"organizationId" = $n` filters — the tenant guard cannot see `$queryRaw` (documented limitation), so org scoping in raw SQL is reviewer-enforced: call it out explicitly in every review.
- Retrieval behavior contract: same return shapes (`KnowledgeHit`, memory hit shape), same `k` defaults, same keyword fallback when `embeddingsConfigured()` is false or the query embed fails, same best-effort try/catch-to-empty semantics.
- DB-backed vector tests must self-skip when `TEST_DATABASE_URL` is unset OR the test DB lacks the `vector` extension (probe `pg_available_extensions` in the gate) — they run for real in CI once the image switches.
- Throwaway local DBs only (never `ci_repro` except at the final gate); no new npm dependencies. Commits direct to `main`; push only at the final task's isolated-worktree gate (typecheck/lint/test, ci_repro migrate-from-zero + DB suite + build, CI green).
- Concurrent-session caveat: commit only files you changed.

---

### Task 1: Infrastructure — local pgvector, CI image, extension smoke test

**Files:**
- Modify: `.github/workflows/ci.yml` (both `services.postgres.image` entries)
- No app code.

**Interfaces:** Produces a local Postgres with pgvector available and a CI config where `CREATE EXTENSION vector` works. Task 2's migration depends on both.

- [ ] **Step 1: Install pgvector locally**

```bash
brew install pgvector
psql -h localhost -d postgres -tc "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'"
```

Expected: one row, `vector | 0.8.5`. If the formula fails against postgresql@18, STOP and report BLOCKED with the brew error — do not improvise a source build.

- [ ] **Step 2: Smoke-test the extension end to end**

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r5_smoke' -c 'CREATE DATABASE ws_r5_smoke'
psql -h localhost -d ws_r5_smoke -c 'CREATE EXTENSION vector' -c "SELECT '[1,2,3]'::vector(3) <=> '[1,2,4]'::vector(3)" -c "SELECT '[1, 2, 3]'::vector(3)"
psql -h localhost -d postgres -c 'DROP DATABASE ws_r5_smoke'
```

Expected: extension creates; distance returns a float; the whitespace-tolerant cast succeeds (this validates the Task 2 backfill's `jsonb::text::vector` cast — jsonb text form contains spaces).

- [ ] **Step 3: Switch the CI Postgres image**

In `.github/workflows/ci.yml`, change BOTH jobs' `image: postgres:16` to `image: pgvector/pgvector:pg16`. Nothing else in the file changes (env, ports, health-cmd all identical — the pgvector image is a drop-in postgres:16 derivative).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: postgres service image ships pgvector — prerequisite for vector-column migration"
```

---

### Task 2: Migration — extension, vector columns, backfill, HNSW indexes

**Files:**
- Modify: `prisma/schema.prisma` (both models + generator preview flag if required)
- Create: `prisma/migrations/<timestamp>_pgvector_embeddings/migration.sql` (generated, then hand-edited)
- Test: `src/lib/__tests__/pgvector-migration.test.ts`

**Interfaces:**
- Consumes: Task 1's infrastructure.
- Produces: `knowledge_chunks.embeddingVec vector(1024)` and `agent_memories.embeddingVec vector(1024)` columns (schema: `embeddingVec Unsupported("vector(1024)")?`), backfilled from the JSON columns where `jsonb_array_length(embedding) = 1024`, with HNSW indexes `knowledge_chunks_embedding_vec_hnsw` / `agent_memories_embedding_vec_hnsw` (`USING hnsw ("embeddingVec" vector_cosine_ops)`). Task 3 queries/writes these columns by exactly these names.

- [ ] **Step 1: Schema edits**

In both models, after the existing `embedding Json?` line:

```prisma
  /// pgvector copy of `embedding` (WS-R5). Reads/writes go through raw SQL —
  /// Prisma cannot query Unsupported columns. The Json column is legacy,
  /// kept for deploy-window safety; drop it in a future migration.
  embeddingVec Unsupported("vector(1024)")?
```

If `prisma migrate dev` refuses `Unsupported` without it, add `previewFeatures = ["postgresqlExtensions"]` to the generator block and `extensions = [vector]` to the datasource — but ONLY if required; prefer the minimal diff (Unsupported columns work without the preview flag; the extension is created by hand-edited SQL).

- [ ] **Step 2: Generate + hand-edit the migration**

Generate against a throwaway DB (`ws_r5_migrate`; create it and `CREATE EXTENSION vector` in it FIRST so `migrate dev` can apply). Then hand-edit the migration.sql to, in order:

```sql
-- pgvector: idempotent — Supabase whitelists the extension; CI/local images ship it (WS-R5 Task 1).
CREATE EXTENSION IF NOT EXISTS vector;

-- (generated ALTER TABLE ... ADD COLUMN "embeddingVec" vector(1024) statements stay here)

-- Backfill from the legacy JSON columns. jsonb's text form ('[0.1, 0.2, ...]')
-- is valid pgvector input (whitespace-tolerant). Dimension-guarded: rows
-- embedded under a non-default model (wrong length) are skipped, not corrupted.
UPDATE "knowledge_chunks" SET "embeddingVec" = ("embedding"::text)::vector(1024)
  WHERE "embedding" IS NOT NULL AND jsonb_array_length("embedding") = 1024;
UPDATE "agent_memories" SET "embeddingVec" = ("embedding"::text)::vector(1024)
  WHERE "embedding" IS NOT NULL AND jsonb_array_length("embedding") = 1024;

CREATE INDEX "knowledge_chunks_embedding_vec_hnsw" ON "knowledge_chunks" USING hnsw ("embeddingVec" vector_cosine_ops);
CREATE INDEX "agent_memories_embedding_vec_hnsw" ON "agent_memories" USING hnsw ("embeddingVec" vector_cosine_ops);
```

Verify the generated ADD COLUMN statements target the correct mapped tables/columns; prove from-zero apply on a fresh throwaway DB (extension line included — from-zero must not require a pre-existing extension). Drop throwaway DBs.

- [ ] **Step 3: Migration DB test**

`src/lib/__tests__/pgvector-migration.test.ts` — DB-gated PLUS vector-probe-gated:

```ts
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  // ... standard env wiring ...
  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
  })
  // every test body: if (!vectorReady) return  — self-skip on non-pgvector DBs
}
```

Assert: inserting a chunk row then `$executeRaw` writing a 1024-dim vector round-trips (`$queryRaw` reads back `embeddingVec IS NOT NULL`); a `<=>` distance query orders two synthetic vectors correctly (nearest first); writing a wrong-dim vector fails loudly (expect the Postgres dimension error).

- [ ] **Step 4: Gate + commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/__tests__/pgvector-migration.test.ts
git commit -m "feat(db): pgvector columns + HNSW indexes for knowledge and memory embeddings — backfilled, JSON legacy kept"
```

---

### Task 3: Retrieval + write paths on vector search

**Files:**
- Modify: `src/lib/knowledge/retrieve.ts` (vector-first retrieval; delete the truncating `cosine`; keep `keywordScore`)
- Modify: `src/lib/memory/agent-memory.ts` (retrieval, suggestion dedup, save-path vector write; `bestAnswerMatch` switches to `cosineSimilarity` from rag/embeddings)
- Modify: `src/lib/knowledge/ingest.ts` (vector write after createMany)
- Test: `src/lib/knowledge/__tests__/retrieve-vector.test.ts`, extend `src/lib/memory/__tests__/` (create if absent — check first)

**Interfaces:**
- Consumes: Task 2's column/index names; `embedQuery`/`embedTexts`/`cosineSimilarity`/`embeddingsConfigured` from rag/embeddings.
- Produces: identical public signatures (`retrieveKnowledge`, `retrieveAgentMemory`, `saveAgentMemory`, `bestAnswerMatch`, `ingestKnowledgeFile`) — callers (execute-agent.ts) unchanged.

- [ ] **Step 1: Failing DB tests** (vector-probe-gated like Task 2's)

Knowledge: seed 3 chunks with synthetic orthogonal-ish vectors via raw UPDATE; `retrieveKnowledge` with a query vector nearest to chunk B returns B first with score ≈ 1 − distance; another org's chunks NEVER appear (org isolation in raw SQL — the load-bearing assertion); keyword fallback still works with embeddings unconfigured (no VOYAGE_API_KEY in test env — pass a query, get keyword-scored results). Memory: same shape for `retrieveAgentMemory` (status='open' filter preserved) + `saveAgentMemory` suggestion-dedup: two near-identical suggestion embeddings → second save dedupes (returns the existing row / skips insert, matching current semantics — read the current return contract first).

- [ ] **Step 2: Implement retrieval**

`retrieveKnowledge` core (shape — adapt to the file's existing param/return types exactly):

```ts
  if (queryVector) {
    const rows = await prisma.$queryRaw<Array<{ content: string; filename: string; distance: number }>>`
      SELECT c."content", d."filename", (c."embeddingVec" <=> ${toSqlVector(queryVector)}::vector(1024)) AS distance
      FROM "knowledge_chunks" c
      JOIN "knowledge_documents" d ON d."id" = c."documentId"
      WHERE c."organizationId" = ${params.organizationId}
        AND (c."agentId" = ${params.agentId} OR c."agentId" IS NULL)
        AND c."embeddingVec" IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${k}
    `
    return rows.map((row) => ({ content: row.content, filename: row.filename, score: 1 - row.distance }))
  }
  // keyword fallback: existing findMany take-capped path, unchanged
```

`toSqlVector(vec: number[]): string` = `` `[${vec.join(',')}]` `` — one shared helper (put it in rag/embeddings.ts next to EMBEDDING_DIM; both files import it). Memory retrieval mirrors this with its `status = 'open'`, `agentId` filters and `LIMIT ${MEMORY_INJECTION_LIMIT}`; dedup uses `ORDER BY distance LIMIT 1` + threshold compare (`1 - distance >= MEMORY_SIMILARITY_THRESHOLD`). Keep every current filter (verify against the existing findMany where-clauses field by field). Preserve the try/catch-to-empty/best-effort contracts.

- [ ] **Step 3: Implement write paths**

`ingestKnowledgeFile`: after `createMany`, if embeddings exist, fetch the created chunk ids (createMany doesn't return them — query by documentId, ordered by ordinal) and write vectors in one statement per chunk or a single `UPDATE ... FROM (VALUES ...)` batch (implementer's choice; batch preferred, show it in the report). `saveAgentMemory`: after `create`, `$executeRaw` UPDATE the row's `embeddingVec`. Both KEEP writing the legacy Json `embedding` too (deploy-window symmetry — reads no longer touch it, the follow-up migration drops it).

- [ ] **Step 4: Consolidate cosine**

Delete `cosine` from knowledge/retrieve.ts; `bestAnswerMatch` + any remaining in-memory scoring use `cosineSimilarity` (strict-length) from rag/embeddings. `keywordScore` stays where it is. Update imports in agent-memory.ts. Grep for any other `cosine` importers.

- [ ] **Step 5: Gate + commit**

Full gate + the new DB tests against a local throwaway DB WITH the extension (`CREATE EXTENSION vector` after create, before `migrate deploy`).

```bash
git add src/lib/knowledge src/lib/memory src/lib/rag/embeddings.ts
git commit -m "feat(rag): knowledge + memory retrieval rank in-database over all rows — 500-row scan cap removed"
```

---

### Task 4: Docs, CI-mode gate, push, final review

- [ ] **Step 1: ARCHITECTURE.md** — in Known follow-ups, add: `- **Drop legacy embedding Json columns.** WS-R5 moved reads/writes to pgvector (embeddingVec); the Json columns are write-only legacy kept for deploy-window safety — drop both in the next schema migration.` And add one sentence to Core Data noting retrieval is pgvector-backed (HNSW, cosine).
- [ ] **Step 2: Isolated-worktree gate** — standard recipe; NOTE: `ci_repro` must get `CREATE EXTENSION vector` is NOT needed manually — the migration itself creates it; from-zero `migrate deploy` proves that.
- [ ] **Step 3: Push + CI green** — CI now runs on the pgvector image; the vector DB tests un-skip in CI for the first time — watch for surprises.
- [ ] **Step 4: Final whole-workstream review** (controller dispatches; most capable model; triage minors).
