-- When a mailbox's signature is put in without being asked for.
--
-- "new" is the default and it is what every other client does: a signature that
-- has to be inserted by hand is one nobody ever sends. Existing mailboxes mostly
-- have no signature at all, so the default changes nothing for them until they
-- write one.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "signatureAuto" TEXT NOT NULL DEFAULT 'new';
