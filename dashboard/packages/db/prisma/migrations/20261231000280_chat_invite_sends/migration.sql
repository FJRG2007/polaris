-- Invitations sent to one person from the invite dialog, so one sender sending
-- the same link to the same person twice posts one message. Additive only.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatInviteSend" (
    "id" UUID NOT NULL,
    "inviteId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "channelId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatInviteSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChatInviteSend_inviteId_senderId_recipientId_key" ON "ChatInviteSend"("inviteId", "senderId", "recipientId");

-- AddForeignKey
ALTER TABLE "ChatInviteSend" DROP CONSTRAINT IF EXISTS "ChatInviteSend_inviteId_fkey";
ALTER TABLE "ChatInviteSend" ADD CONSTRAINT "ChatInviteSend_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "ChatSpaceInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
