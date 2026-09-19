-- Whether a folder's role came from the server marking it as its own Sent,
-- Drafts, Trash and so on, rather than from a name match. False for every
-- existing row; the next sync of each mailbox fills it in.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MailFolder" ADD COLUMN IF NOT EXISTS "roleFlagged" BOOLEAN NOT NULL DEFAULT false;
