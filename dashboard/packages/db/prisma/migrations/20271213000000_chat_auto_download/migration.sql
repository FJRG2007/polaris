-- Media auto-download: which pictures in Chat load on their own for one
-- account. Null is "never chose" and keeps what every account had before (the
-- instance's choice, which defaults to everything).
--
-- Additive only. Written so that running it a second time is a no-op.

ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "chatAutoDownload" TEXT;
