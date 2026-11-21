-- Advanced chat privacy, per conversation. Off for every existing
-- conversation, which is how they behaved before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "advancedPrivacy" BOOLEAN NOT NULL DEFAULT false;
