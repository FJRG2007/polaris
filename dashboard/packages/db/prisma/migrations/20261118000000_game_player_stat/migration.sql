-- The last experience level Polaris saw each player on, so a player who is
-- offline still shows one.
--
-- Written so that running it a second time is a no-op.

CREATE TABLE IF NOT EXISTS "GamePlayerStat" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GamePlayerStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GamePlayerStat_installedAppId_username_key" ON "GamePlayerStat"("installedAppId", "username");
CREATE INDEX IF NOT EXISTS "GamePlayerStat_installedAppId_idx" ON "GamePlayerStat"("installedAppId");
