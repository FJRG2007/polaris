-- Air purifiers and humidifiers in Places.
--
-- How a unit is set (its preset, its fan speed, the humidity it aims for, its
-- switches), what it can be set to, what it measures and how worn its filters
-- are is one document on the device row: read and written whole, never queried
-- by its parts. Its headline figure - the dust, or the humidity on a humidifier -
-- is also the row's reading, like any other sensor's.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "air" JSONB;
