-- The chat soundboard: a space's own sounds, who may not play them, the
-- switches that turn it off for a space or for one conversation, and the sounds
-- each person starred. Additive only.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "ChatSpace" ADD COLUMN IF NOT EXISTS "soundboard" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ChatSpace" ADD COLUMN IF NOT EXISTS "soundboardExternal" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "soundboard" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatSpaceSound" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '',
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "mime" TEXT NOT NULL DEFAULT 'audio/wav',
    "size" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSpaceSound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatSoundboardDenial" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSoundboardDenial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatSoundFavorite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sound" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSoundFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatSpaceSound_spaceId_createdAt_idx" ON "ChatSpaceSound"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatSpaceSound_uploaderId_idx" ON "ChatSpaceSound"("uploaderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChatSoundboardDenial_spaceId_kind_subject_key" ON "ChatSoundboardDenial"("spaceId", "kind", "subject");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChatSoundFavorite_userId_sound_key" ON "ChatSoundFavorite"("userId", "sound");

-- AddForeignKey
ALTER TABLE "ChatSpaceSound" DROP CONSTRAINT IF EXISTS "ChatSpaceSound_spaceId_fkey";
ALTER TABLE "ChatSpaceSound" ADD CONSTRAINT "ChatSpaceSound_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSpaceSound" DROP CONSTRAINT IF EXISTS "ChatSpaceSound_uploaderId_fkey";
ALTER TABLE "ChatSpaceSound" ADD CONSTRAINT "ChatSpaceSound_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSoundboardDenial" DROP CONSTRAINT IF EXISTS "ChatSoundboardDenial_spaceId_fkey";
ALTER TABLE "ChatSoundboardDenial" ADD CONSTRAINT "ChatSoundboardDenial_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSoundFavorite" DROP CONSTRAINT IF EXISTS "ChatSoundFavorite_userId_fkey";
ALTER TABLE "ChatSoundFavorite" ADD CONSTRAINT "ChatSoundFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
