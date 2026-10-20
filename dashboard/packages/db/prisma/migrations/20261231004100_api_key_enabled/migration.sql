-- An API key its owner can switch off and back on. Off is refused exactly like
-- a revoked key, but the key keeps working the moment it is switched back on.
-- Existing keys read as on.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
