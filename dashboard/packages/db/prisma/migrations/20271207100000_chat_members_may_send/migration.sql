-- Whether anybody may post in a conversation, or only whoever runs it: the
-- owner of a group, the administrators of a space channel. On for every
-- existing conversation, which is how they behaved before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "membersMaySend" BOOLEAN NOT NULL DEFAULT true;
