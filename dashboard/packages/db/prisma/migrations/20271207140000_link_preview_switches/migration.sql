-- Switches that stop link previews: per account (for what it sends) and per
-- conversation. Both default to true, which is what every account and
-- conversation had before, so nothing changes until somebody turns one off.
--
-- Additive only. Written to be safe to run twice.
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "linkPreviews" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "linkPreviews" BOOLEAN NOT NULL DEFAULT true;
