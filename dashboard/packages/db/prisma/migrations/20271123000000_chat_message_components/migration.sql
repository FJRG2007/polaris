-- Buttons and forms under a message Polar or an app wrote.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "components" JSONB;
