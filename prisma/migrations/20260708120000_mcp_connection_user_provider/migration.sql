-- AlterTable
ALTER TABLE "mcp_connections" ADD COLUMN "userId" TEXT;
ALTER TABLE "mcp_connections" ADD COLUMN "provider" TEXT;
ALTER TABLE "mcp_connections" ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connections_organizationId_userId_provider_key"
  ON "mcp_connections"("organizationId", "userId", "provider");

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
