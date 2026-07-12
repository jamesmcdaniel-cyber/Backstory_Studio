-- The AI proposal review queue (sub-project C). Additive: a new table only.
-- A proposal is NOT a live template — it is a reviewable suggestion the
-- auto-generation engine writes with status 'open'; nothing is published
-- without an explicit accept.

-- CreateTable
CREATE TABLE "template_proposals" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "configuration" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "sourceEvidence" JSONB NOT NULL,
  "createdTemplateId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "template_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "template_proposals_organizationId_status_idx"
  ON "template_proposals"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "template_proposals" ADD CONSTRAINT "template_proposals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
