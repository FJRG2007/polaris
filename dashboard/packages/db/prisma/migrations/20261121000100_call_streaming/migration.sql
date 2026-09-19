-- Whether each person in a call is sharing a screen, as their browser reports
-- it, so the people outside the call can see who is live.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "streaming" BOOLEAN NOT NULL DEFAULT false;
