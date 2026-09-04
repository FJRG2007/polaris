-- A note handed to somebody who has no account here.
--
-- One link per note, carrying the limits every public link in Polaris carries -
-- a password, an expiry, a cap on opens, and the address allowlists - so it is
-- gated by the same guards a share, a drop point and a snippet are.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- CreateTable
CREATE TABLE IF NOT EXISTS "NoteShare" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" BYTEA,
    "tokenNonce" BYTEA,
    "tokenKeyId" TEXT,
    "passwordHash" TEXT,
    "includeChildren" BOOLEAN NOT NULL DEFAULT true,
    "maxViews" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NoteShare_noteId_key" ON "NoteShare"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NoteShare_tokenHash_key" ON "NoteShare"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteShare_ownerId_idx" ON "NoteShare"("ownerId");

-- AddForeignKey
ALTER TABLE "NoteShare" DROP CONSTRAINT IF EXISTS "NoteShare_noteId_fkey";
ALTER TABLE "NoteShare" ADD CONSTRAINT "NoteShare_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
