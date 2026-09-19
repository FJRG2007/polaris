-- Whether a seat in a call was muted or deafened by somebody who moderates the
-- conversation, which its holder cannot undo. Off for every existing seat. An
-- account's latest seat is looked up to carry that into its next call, hence
-- the index.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "serverMuted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MeetingParticipant" ADD COLUMN IF NOT EXISTS "serverDeafened" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "MeetingParticipant_userId_joinedAt_idx" ON "MeetingParticipant"("userId", "joinedAt");
