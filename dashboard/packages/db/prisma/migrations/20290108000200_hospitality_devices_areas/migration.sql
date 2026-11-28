-- Devices linked to a venue by QR + code, and links being made.
CREATE TABLE IF NOT EXISTS "HospitalityDevice" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDevice_tokenHash_key" ON "HospitalityDevice"("tokenHash");
CREATE INDEX IF NOT EXISTS "HospitalityDevice_venueId_revokedAt_idx" ON "HospitalityDevice"("venueId", "revokedAt");
DO $$ BEGIN
    ALTER TABLE "HospitalityDevice" ADD CONSTRAINT "HospitalityDevice_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "HospitalityDeviceLink" (
    "id" UUID NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "venueId" UUID,
    "name" TEXT NOT NULL DEFAULT '',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "deviceId" UUID,
    "lastPolledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityDeviceLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDeviceLink_userCode_key" ON "HospitalityDeviceLink"("userCode");
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDeviceLink_deviceCodeHash_key" ON "HospitalityDeviceLink"("deviceCodeHash");
CREATE INDEX IF NOT EXISTS "HospitalityDeviceLink_expiresAt_idx" ON "HospitalityDeviceLink"("expiresAt");

-- Areas (outlets) of a venue, their price layer, stations and routing.
CREATE TABLE IF NOT EXISTS "HospitalityArea" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "floorLabel" TEXT NOT NULL DEFAULT '',
    "menuMode" TEXT NOT NULL DEFAULT 'shared',
    "ownTill" BOOLEAN NOT NULL DEFAULT false,
    "header" TEXT NOT NULL DEFAULT '',
    "footer" TEXT NOT NULL DEFAULT '',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityArea_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "HospitalityArea_venueId_position_idx" ON "HospitalityArea"("venueId", "position");
DO $$ BEGIN
    ALTER TABLE "HospitalityArea" ADD CONSTRAINT "HospitalityArea_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "HospitalityAreaOverride" (
    "areaId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "price" INTEGER,
    "available" BOOLEAN,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityAreaOverride_pkey" PRIMARY KEY ("areaId", "productId")
);
CREATE INDEX IF NOT EXISTS "HospitalityAreaOverride_productId_idx" ON "HospitalityAreaOverride"("productId");
DO $$ BEGIN
    ALTER TABLE "HospitalityAreaOverride" ADD CONSTRAINT "HospitalityAreaOverride_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "HospitalityArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "HospitalityStation" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "areaId" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'kitchen',
    "printerId" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityStation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "HospitalityStation_venueId_position_idx" ON "HospitalityStation"("venueId", "position");

CREATE TABLE IF NOT EXISTS "HospitalityRouting" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "areaId" UUID,
    "categoryId" UUID NOT NULL,
    "stationId" UUID NOT NULL,

    CONSTRAINT "HospitalityRouting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityRouting_venueId_areaId_categoryId_key" ON "HospitalityRouting"("venueId", "areaId", "categoryId");
CREATE INDEX IF NOT EXISTS "HospitalityRouting_stationId_idx" ON "HospitalityRouting"("stationId");

ALTER TABLE "HospitalityRoom" ADD COLUMN IF NOT EXISTS "areaId" UUID;
ALTER TABLE "HospitalityShift" ADD COLUMN IF NOT EXISTS "areaId" UUID;
ALTER TABLE "HospitalityOrder" ADD COLUMN IF NOT EXISTS "areaId" UUID;
ALTER TABLE "HospitalityProduct" ADD COLUMN IF NOT EXISTS "areaId" UUID;
ALTER TABLE "HospitalityStaff" ADD COLUMN IF NOT EXISTS "areaIds" UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE "HospitalityDevice" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'terminal';
ALTER TABLE "HospitalityDevice" ADD COLUMN IF NOT EXISTS "areaIds" UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE "HospitalityDevice" ADD COLUMN IF NOT EXISTS "stationId" UUID;
CREATE INDEX IF NOT EXISTS "HospitalityRoom_areaId_idx" ON "HospitalityRoom"("areaId");
CREATE INDEX IF NOT EXISTS "HospitalityOrder_areaId_idx" ON "HospitalityOrder"("areaId");
