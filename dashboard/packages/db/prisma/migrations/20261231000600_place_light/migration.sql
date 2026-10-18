-- Dimmable, tunable and coloured lights in Places.
--
-- How bright a light is, how warm, what colour, and the range it accepts are one
-- document on the device row, read and written whole like an air purifier's.
-- Null for every light that only switches and for every other kind.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "light" JSONB;
