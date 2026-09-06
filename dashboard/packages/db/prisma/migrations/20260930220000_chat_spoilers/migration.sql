-- Attachments that arrive covered.
--
-- False for everything already sent, which is what it was: a file nobody marked
-- is a file nobody meant to hide. `IF NOT EXISTS` because a migration that
-- failed halfway has to be finishable by running it again.
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "spoiler" BOOLEAN NOT NULL DEFAULT false;

-- The same on a message waiting to be sent, so one scheduled with something
-- covered arrives covered rather than quietly uncovering itself on the way.
ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "spoiler" BOOLEAN NOT NULL DEFAULT false;
