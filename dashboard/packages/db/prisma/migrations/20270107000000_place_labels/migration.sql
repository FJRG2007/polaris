-- Labels a place's devices carry across rooms, so an automation can name part
-- of a room or the same thing in several. Additive: nothing existing changes.
CREATE TABLE IF NOT EXISTS "PlaceLabel" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceLabel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PlaceDeviceLabel" (
    "deviceId" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceDeviceLabel_pkey" PRIMARY KEY ("deviceId","labelId")
);

CREATE INDEX IF NOT EXISTS "PlaceLabel_installedAppId_idx" ON "PlaceLabel"("installedAppId");

CREATE UNIQUE INDEX IF NOT EXISTS "PlaceLabel_placeId_name_key" ON "PlaceLabel"("placeId", "name");

CREATE INDEX IF NOT EXISTS "PlaceDeviceLabel_labelId_idx" ON "PlaceDeviceLabel"("labelId");

ALTER TABLE "PlaceLabel" DROP CONSTRAINT IF EXISTS "PlaceLabel_placeId_fkey";
ALTER TABLE "PlaceLabel" ADD CONSTRAINT "PlaceLabel_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceDeviceLabel" DROP CONSTRAINT IF EXISTS "PlaceDeviceLabel_deviceId_fkey";
ALTER TABLE "PlaceDeviceLabel" ADD CONSTRAINT "PlaceDeviceLabel_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PlaceDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceDeviceLabel" DROP CONSTRAINT IF EXISTS "PlaceDeviceLabel_labelId_fkey";
ALTER TABLE "PlaceDeviceLabel" ADD CONSTRAINT "PlaceDeviceLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "PlaceLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
