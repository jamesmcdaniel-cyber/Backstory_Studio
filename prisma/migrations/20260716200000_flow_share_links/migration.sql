-- Cross-workspace jam: durable per-user grants (collaborators) + rotatable
-- tokenized share links. Rotation revokes future opens; accepted rows persist.
CREATE TABLE "public"."flow_collaborators" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'edit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "flow_collaborators_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "flow_collaborators_flowId_userId_key" ON "public"."flow_collaborators"("flowId", "userId");
CREATE INDEX "flow_collaborators_userId_idx" ON "public"."flow_collaborators"("userId");
ALTER TABLE "public"."flow_collaborators"
  ADD CONSTRAINT "flow_collaborators_flowId_fkey" FOREIGN KEY ("flowId")
  REFERENCES "public"."flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."flows" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "public"."flows" ADD COLUMN "shareRole" TEXT NOT NULL DEFAULT 'view';
CREATE UNIQUE INDEX "flows_shareToken_key" ON "public"."flows"("shareToken");
