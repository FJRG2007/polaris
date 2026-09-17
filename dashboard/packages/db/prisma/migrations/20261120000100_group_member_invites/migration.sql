-- Whether the members of a group may add people to it, or only its owner. On
-- for every existing group, which is how groups behaved before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "membersMayInvite" BOOLEAN NOT NULL DEFAULT true;
