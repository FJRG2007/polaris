-- A sealed message's edit history (docs/chat-e2ee-mls.md): each earlier version
-- keeps the sealed columns it had, so a reader's device opens it as it opens
-- the message. Null on every existing row and on every edit of a message that
-- is not sealed.
--
-- Additive, and a no-op when run again.
-- To reverse: ALTER TABLE "ChatMessageEdit" DROP COLUMN IF EXISTS "e2eeCiphertext", DROP COLUMN IF EXISTS "e2eeEpoch", DROP COLUMN IF EXISTS "e2eeSenderLeaf", DROP COLUMN IF EXISTS "e2eeDevice", DROP COLUMN IF EXISTS "e2eeSignature", DROP COLUMN IF EXISTS "e2eeSignatureKey";
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeCiphertext" BYTEA;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeEpoch" BIGINT;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeSenderLeaf" INTEGER;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeDevice" TEXT;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeSignature" BYTEA;
ALTER TABLE "ChatMessageEdit" ADD COLUMN IF NOT EXISTS "e2eeSignatureKey" BYTEA;
