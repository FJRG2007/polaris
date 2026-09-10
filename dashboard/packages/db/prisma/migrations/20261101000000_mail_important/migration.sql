-- Important, as a mark somebody puts on a message.
--
-- The `$Important` keyword on the message, mirrored where the folder stores
-- keywords and kept here alone where it does not. The conversation carries a
-- rolled-up copy the way it carries `starred`, so the list can draw the mark and
-- the Important view can narrow on it without reading every message.
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "important" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MailThread" ADD COLUMN IF NOT EXISTS "important" BOOLEAN NOT NULL DEFAULT false;

-- Whether a folder is known to store keywords. False until learned, because a
-- folder opened read-only reports no permanent flags, and reading that silence
-- as "not important" would wipe marks made here on a server that keeps none.
ALTER TABLE "MailFolder" ADD COLUMN IF NOT EXISTS "keywords" BOOLEAN NOT NULL DEFAULT false;
