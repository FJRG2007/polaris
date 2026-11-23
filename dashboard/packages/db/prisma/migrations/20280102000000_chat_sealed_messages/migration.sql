-- Sealed chat messages, behind the internal chat E2EE flag
-- (docs/chat-e2ee-mls.md): the ciphertext under the conversation's history key,
-- its epoch, the sender's MLS leaf and device, and the device's signature with
-- the key it was checked against. Null on every existing row and on every
-- message sent while the flag is off; nothing reads them then.
--
-- Additive, and a no-op when run again.
-- To reverse: ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "e2eeCiphertext", DROP COLUMN IF EXISTS "e2eeEpoch", DROP COLUMN IF EXISTS "e2eeSenderLeaf", DROP COLUMN IF EXISTS "e2eeDevice", DROP COLUMN IF EXISTS "e2eeSignature", DROP COLUMN IF EXISTS "e2eeSignatureKey";
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeCiphertext" BYTEA;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeEpoch" BIGINT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeSenderLeaf" INTEGER;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeDevice" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeSignature" BYTEA;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "e2eeSignatureKey" BYTEA;
