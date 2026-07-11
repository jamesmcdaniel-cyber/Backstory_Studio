-- Add template provenance + visibility. Existing rows predate the feature and
-- were readable by every workspace (the old GET returned all orgs' rows), so
-- backfill them to 'global' to preserve that community-library behavior. New
-- rows default to 'org' (private to the creating org) and 'user' source.
ALTER TABLE "agent_templates" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "agent_templates" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'org';

-- One-time backfill: every row that exists at migration time is a pre-feature
-- community template → make it globally visible. (No effect on a fresh DB.)
UPDATE "agent_templates" SET "visibility" = 'global';

CREATE INDEX "agent_templates_organizationId_visibility_idx"
  ON "agent_templates"("organizationId", "visibility");
