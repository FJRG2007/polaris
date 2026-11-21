-- Keep in chat: somebody can keep a disappearing message so it stays, its
-- author can forbid that or take every keep back, and a group's owner can keep
-- it to whoever runs the group. Nothing changes for an existing message or
-- conversation: every message stays keepable and unkept, every group open.
--
-- Additive only. Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "membersMayKeep" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "keptExpiresAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "keepable" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "ChatMessageKeep" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageKeep_pkey" PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX IF NOT EXISTS "ChatMessageKeep_userId_createdAt_idx" ON "ChatMessageKeep"("userId", "createdAt");
ALTER TABLE "ChatMessageKeep" DROP CONSTRAINT IF EXISTS "ChatMessageKeep_messageId_fkey";
ALTER TABLE "ChatMessageKeep" ADD CONSTRAINT "ChatMessageKeep_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
