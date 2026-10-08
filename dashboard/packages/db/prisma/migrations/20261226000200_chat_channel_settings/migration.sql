-- A channel's settings page: what its pictures are before anybody looks (and
-- the age gate), invite links that open on one channel, and incoming webhooks.
-- Additive only: every existing channel keeps `default`, every existing invite
-- keeps opening on the space, and no message gains an author it did not have.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "contentMode" TEXT NOT NULL DEFAULT 'default';

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "webhookId" UUID;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "authorLabel" TEXT;

ALTER TABLE "ChatSpaceInvite" ADD COLUMN IF NOT EXISTS "channelId" UUID;
CREATE INDEX IF NOT EXISTS "ChatSpaceInvite_channelId_createdAt_idx" ON "ChatSpaceInvite"("channelId", "createdAt");

ALTER TABLE "ChatSpaceInvite" DROP CONSTRAINT IF EXISTS "ChatSpaceInvite_channelId_fkey";
ALTER TABLE "ChatSpaceInvite"
    ADD CONSTRAINT "ChatSpaceInvite_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatAgeConfirmation" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAgeConfirmation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatAgeConfirmation_channelId_userId_key" ON "ChatAgeConfirmation"("channelId", "userId");

ALTER TABLE "ChatAgeConfirmation" DROP CONSTRAINT IF EXISTS "ChatAgeConfirmation_channelId_fkey";
ALTER TABLE "ChatAgeConfirmation"
    ADD CONSTRAINT "ChatAgeConfirmation_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatWebhook" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatWebhook_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatWebhook_channelId_createdAt_idx" ON "ChatWebhook"("channelId", "createdAt");

ALTER TABLE "ChatWebhook" DROP CONSTRAINT IF EXISTS "ChatWebhook_channelId_fkey";
ALTER TABLE "ChatWebhook"
    ADD CONSTRAINT "ChatWebhook_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
