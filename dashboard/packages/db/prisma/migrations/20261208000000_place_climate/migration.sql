-- Air conditioners in Places.
--
-- How a unit is set (its mode, its target, the range it accepts, its fan and the
-- extras it has) is one document on the device row: it is read and written
-- whole, never queried by its parts. Its room temperature is not in it - that is
-- the row's reading, like any other thermometer's.
--
-- An automation can wait for a unit to change mode, so what a device was last
-- seen doing gains its mode too. Empty for everything that has none.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "climate" JSONB;

-- AlterTable
ALTER TABLE "PlaceDeviceObservation" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlaceDeviceObservation" ADD COLUMN IF NOT EXISTS "modeSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
