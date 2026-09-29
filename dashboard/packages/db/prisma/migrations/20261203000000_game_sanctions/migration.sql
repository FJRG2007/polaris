-- Game sanctions: a ban, timeout or kick put on a player of a game server, so the
-- account that player is linked to can see it on its Account standing page.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "GameSanction" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "player" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),

    CONSTRAINT "GameSanction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GameSanction_installedAppId_player_idx" ON "GameSanction"("installedAppId", "player");
