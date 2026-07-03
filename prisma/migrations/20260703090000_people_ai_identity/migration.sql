-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "peopleAiTeamId" TEXT,
ADD COLUMN "entitlementTier" TEXT,
ADD COLUMN "entitlementStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "entitlementCheckedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "peopleAiMembershipId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_peopleAiTeamId_key" ON "organizations"("peopleAiTeamId");
