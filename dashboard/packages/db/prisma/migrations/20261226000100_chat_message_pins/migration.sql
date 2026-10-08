-- Pinning a message for everybody in a conversation: when, by whom, and until
-- when. Null on every message that already exists, which is no pin - the private
-- star (`ChatStar`) is untouched.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- index and the three columns.

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "pinnedById" UUID;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "pinExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ChatMessage_channelId_pinnedAt_idx" ON "ChatMessage"("channelId", "pinnedAt");
