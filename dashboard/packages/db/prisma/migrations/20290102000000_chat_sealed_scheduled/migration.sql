-- Sealed scheduled messages.
--
-- In a sealed conversation a message scheduled for later is sealed in the
-- writer's browser when it is scheduled, so the waiting row keeps what the
-- device sealed (and an empty body) and never the words. Its sealed files are
-- claimed at the same moment and keep their upload's id, which is what the seal
-- names. Additive: every existing row keeps null / false here, and dropping the
-- columns reverses it.

ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "clientKey" UUID;
ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "e2eeCiphertext" BYTEA;
ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "e2eeEpoch" BIGINT;
ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "e2eeSenderLeaf" INTEGER;
ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "e2eeDevice" TEXT;
ALTER TABLE "ChatScheduledMessage" ADD COLUMN IF NOT EXISTS "e2eeSignature" BYTEA;

ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "sealed" BOOLEAN NOT NULL DEFAULT false;
