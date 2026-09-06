-- Devices at a place: the things Polaris can act on rather than watch.
--
-- A camera is looked at; a door is used. So a device carries a state instead of a
-- stream, and every press it answers is written down - "who opened the office at
-- 03:00" is the question the second table exists for, and it has to keep
-- answering after the vendor's own log has rolled over or the account has been
-- disconnected.
--
-- No credential is stored here. The account's token is one per install and lives
-- in "Setting", envelope-encrypted: ten locks on one account is one secret, and
-- ten copies of it would be ten things to rotate.
--
-- IF NOT EXISTS throughout, and every foreign key dropped by name before it is
-- added, so a run that failed partway is finished by running it again.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceDevice" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID,
    "vendor" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'lock',
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT,
    "model" TEXT,
    "firmware" TEXT,
    "controllable" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'unknown',
    "doorState" TEXT NOT NULL DEFAULT 'none',
    "batteryPercent" INTEGER,
    "batteryCritical" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "stateAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceDeviceEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "externalId" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT,
    "via" TEXT NOT NULL DEFAULT 'system',
    "outcome" TEXT NOT NULL DEFAULT 'ok',
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceDeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One device per id per vendor: a sync on a schedule and a sync somebody asked
-- for can overlap, and the two must not leave a place holding the same door twice.
CREATE UNIQUE INDEX IF NOT EXISTS "PlaceDevice_vendor_externalId_key" ON "PlaceDevice"("vendor", "externalId");
CREATE INDEX IF NOT EXISTS "PlaceDevice_installedAppId_idx" ON "PlaceDevice"("installedAppId");
CREATE INDEX IF NOT EXISTS "PlaceDevice_placeId_idx" ON "PlaceDevice"("placeId");

-- CreateIndex
-- The vendor's own id for the same entry, which is what makes re-reading their
-- log idempotent. Rows Polaris wrote itself carry no external id, and Postgres
-- treats each NULL as distinct, so those are never collapsed into one another.
CREATE UNIQUE INDEX IF NOT EXISTS "PlaceDeviceEvent_deviceId_externalId_key" ON "PlaceDeviceEvent"("deviceId", "externalId");
CREATE INDEX IF NOT EXISTS "PlaceDeviceEvent_deviceId_at_idx" ON "PlaceDeviceEvent"("deviceId", "at");

-- AddForeignKey
-- The place is set to null rather than cascaded: deleting a place must not take
-- the record of who came through its door with it.
ALTER TABLE "PlaceDevice" DROP CONSTRAINT IF EXISTS "PlaceDevice_placeId_fkey";
ALTER TABLE "PlaceDevice" ADD CONSTRAINT "PlaceDevice_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceDeviceEvent" DROP CONSTRAINT IF EXISTS "PlaceDeviceEvent_deviceId_fkey";
ALTER TABLE "PlaceDeviceEvent" ADD CONSTRAINT "PlaceDeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PlaceDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
