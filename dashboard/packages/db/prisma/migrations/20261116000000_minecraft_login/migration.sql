-- Passwords players set on a Minecraft server that runs Polaris's login mod, and
-- the last time each such server's mod reached Polaris.
--
-- Every statement is written so that running it a second time is a no-op. Postgres
-- does not roll a migration back statement by statement, so one that fails halfway
-- leaves what came before it applied and the history marked failed - and the
-- deployment then re-runs this file from the top.
CREATE TABLE IF NOT EXISTS "MinecraftLogin" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftLogin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MinecraftLogin_installedAppId_username_key" ON "MinecraftLogin"("installedAppId", "username");

CREATE INDEX IF NOT EXISTS "MinecraftLogin_installedAppId_idx" ON "MinecraftLogin"("installedAppId");

CREATE TABLE IF NOT EXISTS "MinecraftLoginCheckIn" (
    "installedAppId" UUID NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "modVersion" TEXT NOT NULL,
    "gameVersion" TEXT NOT NULL,

    CONSTRAINT "MinecraftLoginCheckIn_pkey" PRIMARY KEY ("installedAppId")
);
