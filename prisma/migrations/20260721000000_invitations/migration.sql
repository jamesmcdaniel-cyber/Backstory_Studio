-- Pending organization invitations. The plaintext token is emailed (and shown
-- once to the inviter); only its SHA-256 hash is stored here. Accepting moves
-- the invited user into this org with `role` (membership is a single-org FK on
-- users, so accepting reassigns users.organizationId).
CREATE TABLE "public"."invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT,
    "acceptedByUserId" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(6),
    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "public"."invitations"("tokenHash");
CREATE INDEX "invitations_organizationId_idx" ON "public"."invitations"("organizationId");
CREATE INDEX "invitations_email_idx" ON "public"."invitations"("email");

ALTER TABLE "public"."invitations" ADD CONSTRAINT "invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
