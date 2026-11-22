-- Note templates: several per shelf, at most one the default.
CREATE TABLE IF NOT EXISTS "NoteTemplate" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "spaceId" UUID,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "body" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NoteTemplate_spaceId_idx" ON "NoteTemplate"("spaceId");

CREATE INDEX IF NOT EXISTS "NoteTemplate_ownerId_spaceId_idx" ON "NoteTemplate"("ownerId", "spaceId");

ALTER TABLE "NoteTemplate" DROP CONSTRAINT IF EXISTS "NoteTemplate_ownerId_fkey";
ALTER TABLE "NoteTemplate" ADD CONSTRAINT "NoteTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteTemplate" DROP CONSTRAINT IF EXISTS "NoteTemplate_spaceId_fkey";
ALTER TABLE "NoteTemplate" ADD CONSTRAINT "NoteTemplate_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "NoteSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
