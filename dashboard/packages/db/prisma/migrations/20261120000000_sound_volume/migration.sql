-- How loud an account's sounds are, as a percentage. Null follows the default
-- in code, so every existing account keeps the volume it always heard.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "soundVolume" INTEGER;
