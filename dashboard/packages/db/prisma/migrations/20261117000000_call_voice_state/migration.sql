-- Whether each person in a call is muted or deafened, as their browser reports
-- it, so the people outside the call can see it.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "muted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "deafened" BOOLEAN NOT NULL DEFAULT false;
