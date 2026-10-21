-- Litter boxes in Places.
--
-- What a self-cleaning litter box last reported - its cycle, litter level,
-- waste bin, deodorizer, today's visits and its settings - is one document on
-- the device row, read and written whole and never queried by its parts, like
-- a kitchen appliance's.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "litter" JSONB;
