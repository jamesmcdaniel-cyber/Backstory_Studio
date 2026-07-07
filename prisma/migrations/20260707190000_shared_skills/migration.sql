-- Public community library of user-authored skills.
CREATE TABLE "shared_skills" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL DEFAULT 'Community',
  "instructions" TEXT NOT NULL,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "integrations" JSONB NOT NULL DEFAULT '[]',
  "authorName" TEXT NOT NULL DEFAULT '',
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shared_skills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shared_skills_isActive_updatedAt_idx" ON "shared_skills"("isActive", "updatedAt");
