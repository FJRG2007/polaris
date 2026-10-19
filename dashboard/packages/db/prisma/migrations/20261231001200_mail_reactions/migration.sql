-- Emoji reactions on mail, in the format Gmail reads and writes. A message that
-- is a reaction keeps its emoji, so a conversation can draw it under the message
-- it reacts to instead of as a reply of its own; a draft that is one keeps it so
-- the queue can build the reaction part when it sends. Both default to "", which
-- is every message and draft that already exists.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "reaction" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MailDraft" ADD COLUMN IF NOT EXISTS "reaction" TEXT NOT NULL DEFAULT '';
