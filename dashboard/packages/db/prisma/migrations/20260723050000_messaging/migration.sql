-- Unified messaging: connected channels, conversations and normalized messages
-- powering the Inbox. Live adapters run in the messaging bridge; these rows are
-- the control-plane record. owner/assignee/assistant are bare uuids (no FK).
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "provider" TEXT,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "config" TEXT NOT NULL DEFAULT '{}',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Channel_ownerId_idx" ON "Channel"("ownerId");

CREATE INDEX "Channel_platform_idx" ON "Channel"("platform");

CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "peerId" TEXT NOT NULL,
    "peerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeId" UUID,
    "assistantId" UUID,
    "lastMessageAt" TIMESTAMP(3),
    "unread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_channelId_peerId_key" ON "Conversation"("channelId", "peerId");

CREATE INDEX "Conversation_channelId_status_idx" ON "Conversation"("channelId", "status");

CREATE INDEX "Conversation_assigneeId_idx" ON "Conversation"("assigneeId");

CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "externalId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT,
    "payload" TEXT,
    "ack" TEXT,
    "senderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

CREATE INDEX "Message_externalId_idx" ON "Message"("externalId");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
