-- Which version of a sealed message its content and signature are bound to
-- (docs/chat-e2ee-mls.md, "Editing"): null (0) as sent, one more per sealed
-- edit, on the message and on each earlier version its edit history keeps.
-- Null on every existing row, which is revision 0 - what every message sealed
-- before revisions existed was signed as.
--
-- Additive, and a no-op when run again.
-- To reverse: ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "e2eeRevision"; ALTER TABLE "ChatMessageEdit" DROP COLUMN IF EXISTS "e2eeRevision";
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeRevision" INTEGER;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeRevision" INTEGER;
