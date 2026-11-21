-- Invitations to a group conversation, sent when somebody's "who can add me to
-- groups" refuses the person adding them.
--
-- Additive only: one new table. Written to be safe to run twice.
CREATE TABLE IF NOT EXISTS "ChatGroupInvite" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "inviterId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),

    CONSTRAINT "ChatGroupInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatGroupInvite_channelId_inviteeId_key" ON "ChatGroupInvite"("channelId", "inviteeId");
CREATE INDEX IF NOT EXISTS "ChatGroupInvite_inviteeId_createdAt_idx" ON "ChatGroupInvite"("inviteeId", "createdAt");
ALTER TABLE "ChatGroupInvite" DROP CONSTRAINT IF EXISTS "ChatGroupInvite_channelId_fkey";
ALTER TABLE "ChatGroupInvite" ADD CONSTRAINT "ChatGroupInvite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatGroupInvite" DROP CONSTRAINT IF EXISTS "ChatGroupInvite_inviterId_fkey";
ALTER TABLE "ChatGroupInvite" ADD CONSTRAINT "ChatGroupInvite_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatGroupInvite" DROP CONSTRAINT IF EXISTS "ChatGroupInvite_inviteeId_fkey";
ALTER TABLE "ChatGroupInvite" ADD CONSTRAINT "ChatGroupInvite_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
