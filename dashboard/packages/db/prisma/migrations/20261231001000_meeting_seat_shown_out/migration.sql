-- Whether a call seat was closed by a moderator showing its owner out. Additive
-- only: every existing seat reads as closed by its own browser, which is what
-- they were treated as before.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "shownOut" BOOLEAN NOT NULL DEFAULT false;
