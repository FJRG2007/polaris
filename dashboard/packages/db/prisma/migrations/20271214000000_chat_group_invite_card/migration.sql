-- A group invitation now arrives as a card in the direct message between the
-- person who asked and the person asked. This marks when that card was posted
-- (or tried), so it is posted once; pending invitations from before it read
-- null and get their card the first time the invitee opens Chat.
--
-- Additive only. Written so that running it a second time is a no-op.

ALTER TABLE "ChatGroupInvite" ADD COLUMN IF NOT EXISTS "cardPostedAt" TIMESTAMP(3);
