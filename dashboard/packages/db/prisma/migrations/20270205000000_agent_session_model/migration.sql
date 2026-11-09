-- The provider and model an OpenCode session works with: additive, nullable.
-- Existing sessions keep null, which is what a tool that signs in its own way
-- has. Nothing existing is rewritten or removed, and running it twice is a
-- no-op. To reverse: drop the three columns.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "modelProvider" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "modelPayer" TEXT;
