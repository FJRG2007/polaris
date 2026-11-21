-- The key a client gives a message it sends, so a retry from the outbox finds the
-- message it already made instead of making a second one.
--
-- Additive only: one nullable column and its index. Written to be safe to run twice.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientKey" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_authorId_clientKey_key" ON "ChatMessage"("authorId", "clientKey");
