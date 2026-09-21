-- A file already on the storage, waiting for the message that will carry it.
--
-- A conversation used to take its files inside the request that sent the message,
-- so every byte passed through the dashboard's memory - which is what held the
-- per-file limit at a hundred megabytes. A file is streamed to the storage first
-- now, under its own request, and the message names what was written.
CREATE TABLE IF NOT EXISTS "ChatUpload" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" BIGINT NOT NULL DEFAULT 0,
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "spoiler" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUpload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChatUpload_userId_createdAt_idx" ON "ChatUpload"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "ChatUpload_channelId_idx" ON "ChatUpload"("channelId");

-- A constraint cannot be added conditionally, so each one is dropped by name
-- first: that is what lets this migration finish a run that failed halfway.
ALTER TABLE "ChatUpload" DROP CONSTRAINT IF EXISTS "ChatUpload_userId_fkey";
ALTER TABLE "ChatUpload" ADD CONSTRAINT "ChatUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatUpload" DROP CONSTRAINT IF EXISTS "ChatUpload_channelId_fkey";
ALTER TABLE "ChatUpload" ADD CONSTRAINT "ChatUpload_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
