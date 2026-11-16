-- Chat: disappearing messages, delete for me, delete the chat, DM rule agreements.
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "vanishAfter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "deleteForAll" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "rulesAgreedAt" TIMESTAMP(3);
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "clearedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ChatMessage_expiresAt_idx" ON "ChatMessage"("expiresAt");
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "chatVanishAfter" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "ChatMessageHidden" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessageHidden_pkey" PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX IF NOT EXISTS "ChatMessageHidden_userId_idx" ON "ChatMessageHidden"("userId");
ALTER TABLE "ChatMessageHidden" DROP CONSTRAINT IF EXISTS "ChatMessageHidden_messageId_fkey";
ALTER TABLE "ChatMessageHidden" ADD CONSTRAINT "ChatMessageHidden_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatRuleProposal" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "proposedById" UUID NOT NULL,
    "vanishAfter" INTEGER NOT NULL DEFAULT 0,
    "deleteForAll" BOOLEAN NOT NULL DEFAULT false,
    "acceptedBy" UUID[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "ChatRuleProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatRuleProposal_channelId_status_idx" ON "ChatRuleProposal"("channelId", "status");
ALTER TABLE "ChatRuleProposal" DROP CONSTRAINT IF EXISTS "ChatRuleProposal_channelId_fkey";
ALTER TABLE "ChatRuleProposal" ADD CONSTRAINT "ChatRuleProposal_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
