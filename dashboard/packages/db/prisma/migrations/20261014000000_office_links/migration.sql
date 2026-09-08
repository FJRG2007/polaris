-- A link that opens one document, for somebody who has no account here. The
-- other half of sharing: a grant hands a document to a person, a team or a role,
-- all of which are accounts; this is for everybody else.
--
-- Only the token's hash is stored, so a database dump yields no working links.
-- The token itself is kept beside it under the master key so its owner can be
-- shown the link again - one they cannot re-read is one they have to replace.
CREATE TABLE IF NOT EXISTS "OfficeLink" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" BYTEA,
    "tokenNonce" BYTEA,
    "tokenKeyId" TEXT,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OfficeLink_tokenHash_key" ON "OfficeLink"("tokenHash");
CREATE INDEX IF NOT EXISTS "OfficeLink_documentId_idx" ON "OfficeLink"("documentId");

ALTER TABLE "OfficeLink" DROP CONSTRAINT IF EXISTS "OfficeLink_documentId_fkey";
ALTER TABLE "OfficeLink" ADD CONSTRAINT "OfficeLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OfficeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
