-- A low-battery line per device: additive and nullable. Every existing device
-- has none, which reads as its kind's line.
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "batteryLowPercent" INTEGER;
