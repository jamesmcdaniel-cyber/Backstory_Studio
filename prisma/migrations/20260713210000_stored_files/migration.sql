-- Original-file storage: Supabase Storage when configured, inline bytes otherwise.
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'db',
    "storagePath" TEXT,
    "data" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stored_files_organizationId_createdAt_idx" ON "stored_files"("organizationId", "createdAt");

ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
