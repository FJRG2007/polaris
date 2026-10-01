-- Air purifiers in automations.
--
-- A purifier reports several figures at once - the dust, the humidity, the life
-- left in its filters - and an automation can wait for any one of them to cross
-- a line, or for a filter to need changing. What a device was last seen doing
-- gains those figures, each with when it last changed, as one document. Empty
-- for everything else.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDeviceObservation" ADD COLUMN IF NOT EXISTS "figures" JSONB NOT NULL DEFAULT '{}';
