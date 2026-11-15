-- A history of what devices measure: raw samples for a week, hourly after.
-- Additive and re-runnable; reversed by dropping the two tables and the column.
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "readingsOff" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "PlaceDeviceReading" (
    "deviceId" UUID NOT NULL,
    "measure" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "PlaceDeviceReading_pkey" PRIMARY KEY ("deviceId", "measure", "at")
);

CREATE TABLE IF NOT EXISTS "PlaceDeviceReadingHour" (
    "deviceId" UUID NOT NULL,
    "measure" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "avg" DOUBLE PRECISION NOT NULL,
    "min" DOUBLE PRECISION NOT NULL,
    "max" DOUBLE PRECISION NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "PlaceDeviceReadingHour_pkey" PRIMARY KEY ("deviceId", "measure", "hour")
);

CREATE INDEX IF NOT EXISTS "PlaceDeviceReadingHour_hour_idx" ON "PlaceDeviceReadingHour"("hour");

ALTER TABLE "PlaceDeviceReading" DROP CONSTRAINT IF EXISTS "PlaceDeviceReading_deviceId_fkey";
ALTER TABLE "PlaceDeviceReading" ADD CONSTRAINT "PlaceDeviceReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PlaceDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceDeviceReadingHour" DROP CONSTRAINT IF EXISTS "PlaceDeviceReadingHour_deviceId_fkey";
ALTER TABLE "PlaceDeviceReadingHour" ADD CONSTRAINT "PlaceDeviceReadingHour_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PlaceDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
