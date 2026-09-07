-- What a device that measures something last read.
--
-- Places could draw things that are done - a lock, a switch - and nothing that is
-- merely true: a door contact, a temperature, a movement detector. Those are most
-- of what is on a house's broker, and they have no state in the sense that column
-- means. They have a reading.
--
-- Text rather than a number, because half of them are not numbers. A contact says
-- open or closed; a temperature that lost its decimal to a rounding choice made
-- here is worse than the string its own maker sent.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "value" TEXT;
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "unit" TEXT;
