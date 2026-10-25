-- Whether opening Polar brings back the last chat. Off for everybody, so
-- Polar opens on a new chat until the person turns it on. A column with a
-- default only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "reopenLastChat" BOOLEAN NOT NULL DEFAULT false;
