-- Announcement channels: other channels follow one, and what it publishes is
-- copied into each follower once.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "publishedFromId" UUID;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "publishedFromChannelId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_channelId_publishedFromId_key" ON "ChatMessage"("channelId", "publishedFromId");

CREATE TABLE IF NOT EXISTS "ChatChannelFollow" (
    "id" UUID NOT NULL,
    "sourceChannelId" UUID NOT NULL,
    "targetChannelId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatChannelFollow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatChannelFollow_sourceChannelId_targetChannelId_key" ON "ChatChannelFollow"("sourceChannelId", "targetChannelId");

CREATE INDEX IF NOT EXISTS "ChatChannelFollow_targetChannelId_idx" ON "ChatChannelFollow"("targetChannelId");

ALTER TABLE "ChatChannelFollow" DROP CONSTRAINT IF EXISTS "ChatChannelFollow_sourceChannelId_fkey";
ALTER TABLE "ChatChannelFollow" ADD CONSTRAINT "ChatChannelFollow_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatChannelFollow" DROP CONSTRAINT IF EXISTS "ChatChannelFollow_targetChannelId_fkey";
ALTER TABLE "ChatChannelFollow" ADD CONSTRAINT "ChatChannelFollow_targetChannelId_fkey" FOREIGN KEY ("targetChannelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
