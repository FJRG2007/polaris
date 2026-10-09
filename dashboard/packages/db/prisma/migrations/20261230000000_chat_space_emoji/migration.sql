-- A space's own emoji. Additive only: a new table, nothing existing changes.

CREATE TABLE IF NOT EXISTS "ChatSpaceEmoji" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "uploaderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSpaceEmoji_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatSpaceEmoji_spaceId_nameKey_key" ON "ChatSpaceEmoji"("spaceId", "nameKey");
CREATE INDEX IF NOT EXISTS "ChatSpaceEmoji_spaceId_animated_createdAt_idx" ON "ChatSpaceEmoji"("spaceId", "animated", "createdAt");
CREATE INDEX IF NOT EXISTS "ChatSpaceEmoji_uploaderId_idx" ON "ChatSpaceEmoji"("uploaderId");

ALTER TABLE "ChatSpaceEmoji" DROP CONSTRAINT IF EXISTS "ChatSpaceEmoji_spaceId_fkey";
ALTER TABLE "ChatSpaceEmoji"
    ADD CONSTRAINT "ChatSpaceEmoji_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatSpaceEmoji" DROP CONSTRAINT IF EXISTS "ChatSpaceEmoji_uploaderId_fkey";
ALTER TABLE "ChatSpaceEmoji"
    ADD CONSTRAINT "ChatSpaceEmoji_uploaderId_fkey"
    FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
