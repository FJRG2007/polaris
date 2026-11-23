-- A member the server runs (Polar), added to a conversation by a person
-- (docs/chat-e2ee-mls.md, "Server-run members"). Additive: a new table, nothing
-- existing changes; no conversation has one until somebody adds it.
CREATE TABLE IF NOT EXISTS "ChatServiceMember" (
    "channelId" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "addedById" UUID,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatServiceMember_pkey" PRIMARY KEY ("channelId","service")
);

ALTER TABLE "ChatServiceMember" DROP CONSTRAINT IF EXISTS "ChatServiceMember_channelId_fkey";
ALTER TABLE "ChatServiceMember" ADD CONSTRAINT "ChatServiceMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
