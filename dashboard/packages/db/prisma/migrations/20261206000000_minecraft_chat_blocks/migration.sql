-- Chat lines Polaris's mod or plugin stopped on a Minecraft server, for the
-- Moderation tab and for counting a player's strikes towards a timeout.
--
-- Every statement is written so that running it a second time is a no-op.
-- CreateTable
CREATE TABLE IF NOT EXISTS "MinecraftChatBlock" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "player" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "command" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftChatBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MinecraftChatBlock_installedAppId_at_idx" ON "MinecraftChatBlock"("installedAppId", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MinecraftChatBlock_installedAppId_player_at_idx" ON "MinecraftChatBlock"("installedAppId", "player", "at");
