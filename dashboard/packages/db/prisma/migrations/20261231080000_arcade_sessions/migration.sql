-- Games played together: the session a call hosts and who has played in it,
-- read by the card in the call's conversation. Two new tables only; nothing
-- existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "ArcadeSession" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "game" TEXT NOT NULL,
    "startedById" UUID NOT NULL,
    "messageId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "ArcadeSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ArcadeSession_meetingId_endedAt_idx" ON "ArcadeSession"("meetingId", "endedAt");

CREATE TABLE IF NOT EXISTS "ArcadeSessionPlayer" (
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    CONSTRAINT "ArcadeSessionPlayer_pkey" PRIMARY KEY ("sessionId", "userId")
);

ALTER TABLE "ArcadeSessionPlayer" DROP CONSTRAINT IF EXISTS "ArcadeSessionPlayer_sessionId_fkey";
ALTER TABLE "ArcadeSessionPlayer" ADD CONSTRAINT "ArcadeSessionPlayer_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ArcadeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
