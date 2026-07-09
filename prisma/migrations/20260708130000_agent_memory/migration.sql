-- AlterTable
ALTER TABLE "agent_tasks" ADD COLUMN "goal" TEXT;

-- CreateTable
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

-- AddForeignKey
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
