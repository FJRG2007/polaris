-- Where a place is, for sunrise and sunset.
--
-- Two nullable columns: every existing place starts with none, and nothing
-- reads them but the sun. The values are rounded to 2 decimals (about a
-- kilometre) before they are written.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "Place" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "Place" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
