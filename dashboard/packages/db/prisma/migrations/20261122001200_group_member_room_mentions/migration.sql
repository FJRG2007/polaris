-- Whether the members of a group may use @everyone and @here, or only its
-- owner. On for every existing group, which is how groups behaved before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "membersMayMention" BOOLEAN NOT NULL DEFAULT true;
