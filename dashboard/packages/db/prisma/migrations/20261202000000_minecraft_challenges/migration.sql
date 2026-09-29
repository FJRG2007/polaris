-- Minecraft challenges: one row per player and server with what they were
-- dealt, and one per player and season with their points and streak.
--
-- Every statement is written so that running it a second time is a no-op. Postgres
-- does not roll a migration back statement by statement, so one that fails halfway
-- leaves what came before it applied and the history marked failed - and the
-- deployment then re-runs this file from the top.
CREATE TABLE IF NOT EXISTS "MinecraftChallengePlayer" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "player" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftChallengePlayer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MinecraftChallengeLedger" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftChallengeLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MinecraftChallengePlayer_installedAppId_player_key" ON "MinecraftChallengePlayer"("installedAppId", "player");

CREATE INDEX IF NOT EXISTS "MinecraftChallengePlayer_installedAppId_updatedAt_idx" ON "MinecraftChallengePlayer"("installedAppId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "MinecraftChallengeLedger_scope_holder_key" ON "MinecraftChallengeLedger"("scope", "holder");
