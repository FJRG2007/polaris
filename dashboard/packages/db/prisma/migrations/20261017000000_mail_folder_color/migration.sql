-- A colour on a folder, so a rail of twenty grey rows has two or three somebody
-- can find without reading. Only ever written from Polaris: IMAP has no notion
-- of it, so a resync leaves it alone.
ALTER TABLE "MailFolder" ADD COLUMN IF NOT EXISTS "color" TEXT NOT NULL DEFAULT '';
