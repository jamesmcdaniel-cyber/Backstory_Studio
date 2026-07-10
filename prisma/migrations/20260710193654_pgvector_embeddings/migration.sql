-- pgvector: idempotent — Supabase whitelists the extension; CI/local images ship it (WS-R5 Task 1).
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "public"."agent_memories" ADD COLUMN     "embeddingVec" vector(1024);

-- AlterTable
ALTER TABLE "public"."knowledge_chunks" ADD COLUMN     "embeddingVec" vector(1024);

-- Backfill from the legacy JSON columns. jsonb's text form ('[0.1, 0.2, ...]')
-- is valid pgvector input (whitespace-tolerant). Dimension-guarded: rows
-- embedded under a non-default model (wrong length) are skipped, not corrupted.
UPDATE "knowledge_chunks" SET "embeddingVec" = ("embedding"::text)::vector(1024)
  WHERE "embedding" IS NOT NULL AND jsonb_array_length("embedding") = 1024;
UPDATE "agent_memories" SET "embeddingVec" = ("embedding"::text)::vector(1024)
  WHERE "embedding" IS NOT NULL AND jsonb_array_length("embedding") = 1024;

CREATE INDEX "knowledge_chunks_embedding_vec_hnsw" ON "knowledge_chunks" USING hnsw ("embeddingVec" vector_cosine_ops);
CREATE INDEX "agent_memories_embedding_vec_hnsw" ON "agent_memories" USING hnsw ("embeddingVec" vector_cosine_ops);
