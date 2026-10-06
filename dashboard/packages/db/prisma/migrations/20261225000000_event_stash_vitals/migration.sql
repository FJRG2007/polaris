-- A player's health and hunger as they came into an event, kept with the rest
-- of what is given back to them. Null on every row that already exists, which
-- is given back exactly as before.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- four columns.

ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "health" DOUBLE PRECISION;
ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "foodLevel" INTEGER;
ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "foodSaturation" DOUBLE PRECISION;
ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "foodExhaustion" DOUBLE PRECISION;
