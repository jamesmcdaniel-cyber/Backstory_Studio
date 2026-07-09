-- CreateTable
CREATE TABLE "flow_versions" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "graph" JSONB NOT NULL,
  "trigger" JSONB NOT NULL,
  "note" TEXT,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" TEXT,
  CONSTRAINT "flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flow_versions_flowId_version_key" ON "flow_versions"("flowId", "version");
CREATE INDEX "flow_versions_organizationId_flowId_idx" ON "flow_versions"("organizationId", "flowId");

-- AddForeignKey
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every already-published flow's live version becomes its first
-- recorded snapshot, so Version history is never empty for existing flows.
INSERT INTO "flow_versions" ("id", "flowId", "organizationId", "version", "graph", "trigger", "publishedAt", "publishedBy")
SELECT
  'fv_' || md5(random()::text || clock_timestamp()::text),
  f."id", f."organizationId", f."version", f."publishedGraph", f."trigger",
  COALESCE(f."updatedAt", CURRENT_TIMESTAMP), f."userId"
FROM "flows" f
WHERE f."publishedGraph" IS NOT NULL;
