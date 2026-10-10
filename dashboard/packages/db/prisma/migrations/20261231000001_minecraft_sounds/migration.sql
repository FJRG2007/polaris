-- A Minecraft server's own sounds (the game-servers app's Sounds tab) and what
-- the server does with them. Additive only.
--
-- Every statement is written so that running it a second time is a no-op.
-- CreateTable
CREATE TABLE IF NOT EXISTS "MinecraftSound" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sha1" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "channels" INTEGER NOT NULL,
    "sampleRate" INTEGER NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "replaces" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftSound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MinecraftSoundPack" (
    "installedAppId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftSoundPack_pkey" PRIMARY KEY ("installedAppId")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MinecraftSound_installedAppId_key_key" ON "MinecraftSound"("installedAppId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MinecraftSound_installedAppId_idx" ON "MinecraftSound"("installedAppId");
