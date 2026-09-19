-- How many people a voice channel holds at once. Zero is no limit, which is
-- every existing channel.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "userLimit" INTEGER NOT NULL DEFAULT 0;
