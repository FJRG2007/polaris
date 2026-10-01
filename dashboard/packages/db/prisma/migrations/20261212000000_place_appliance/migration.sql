-- Kitchen appliances in Places.
--
-- What an airfryer, a multicooker or an espresso machine last reported doing -
-- its status, its programme, the temperature it is set to and has reached, and
-- the time left - is one document on the device row, read and written whole
-- and never queried by its parts, like an air purifier's settings.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "appliance" JSONB;
