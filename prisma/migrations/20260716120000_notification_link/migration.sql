-- Jam invites (and future notifications) deep-link somewhere specific; the
-- bell previously reconstructed hrefs from executionId, which is null for
-- invites and sent recipients to /dashboard instead of the invited flow.
ALTER TABLE "public"."notifications" ADD COLUMN "link" TEXT;
