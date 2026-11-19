-- Ephemeral chat messages: who may see one. Empty is everybody, which every
-- existing row is. Additive and rerunnable.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "audience" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
