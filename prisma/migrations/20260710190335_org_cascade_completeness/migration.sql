-- Orphan cleanup: rows referencing organizations that no longer exist would
-- violate the new FKs. Each DELETE targets a root's own orphaned rows; any
-- rows in that root's already-cascading children (flow_runs, flow_run_steps,
-- flow_versions off flows; knowledge_chunks off knowledge_documents) are
-- removed automatically by the existing cascade FKs when the root row goes.
DELETE FROM "public"."custom_signals" WHERE "organizationId" NOT IN (SELECT "id" FROM "public"."organizations");
DELETE FROM "public"."push_subscriptions" WHERE "organizationId" NOT IN (SELECT "id" FROM "public"."organizations");
DELETE FROM "public"."flows" WHERE "organizationId" NOT IN (SELECT "id" FROM "public"."organizations");
DELETE FROM "public"."knowledge_documents" WHERE "organizationId" NOT IN (SELECT "id" FROM "public"."organizations");
DELETE FROM "public"."shared_skills" WHERE "organizationId" NOT IN (SELECT "id" FROM "public"."organizations");

-- AddForeignKey
ALTER TABLE "public"."custom_signals" ADD CONSTRAINT "custom_signals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."push_subscriptions" ADD CONSTRAINT "push_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flows" ADD CONSTRAINT "flows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."knowledge_documents" ADD CONSTRAINT "knowledge_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shared_skills" ADD CONSTRAINT "shared_skills_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
