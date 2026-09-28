-- What Polaris's anti-cheat plugin caught on a Minecraft server, one row per alert.
--
-- Every statement is written so that running it a second time is a no-op. Postgres
-- does not roll a migration back statement by statement, so one that fails halfway
-- leaves what came before it applied and the history marked failed - and the
-- deployment then re-runs this file from the top.
CREATE TABLE IF NOT EXISTS "MinecraftAnticheatFlag" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "player" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "violations" INTEGER NOT NULL,
    "verbose" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftAnticheatFlag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MinecraftAnticheatFlag_installedAppId_at_idx" ON "MinecraftAnticheatFlag"("installedAppId", "at");

CREATE INDEX IF NOT EXISTS "MinecraftAnticheatFlag_installedAppId_player_idx" ON "MinecraftAnticheatFlag"("installedAppId", "player");
