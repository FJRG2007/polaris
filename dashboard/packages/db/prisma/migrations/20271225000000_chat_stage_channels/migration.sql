-- Stage channels: a voice channel whose newcomers listen until a moderator
-- invites them to speak.
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "stage" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "audience" BOOLEAN NOT NULL DEFAULT false;
