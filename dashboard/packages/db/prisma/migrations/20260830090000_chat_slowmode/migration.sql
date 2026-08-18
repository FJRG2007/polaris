-- How long somebody waits between messages in one channel, in seconds.
--
-- Zero is off, which is what every channel that already exists is: the default
-- covers the backfill, so no row has to be touched and nothing changes for a
-- deployment that never opens the setting.
ALTER TABLE "ChatChannel" ADD COLUMN "slowmode" INTEGER NOT NULL DEFAULT 0;
