-- Reports of a whole conversation, and of a person from inside one, carry the
-- last messages the reporter could read. Every existing report is a report of
-- one message with nothing attached, which is what the defaults say.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatReport" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'message';
ALTER TABLE "ChatReport" ADD COLUMN IF NOT EXISTS "context" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "SafetyCase" ADD COLUMN IF NOT EXISTS "context" JSONB NOT NULL DEFAULT '[]';
