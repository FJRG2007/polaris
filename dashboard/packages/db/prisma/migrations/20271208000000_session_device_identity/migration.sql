-- The computer a session or device sign-in runs on, as its client claims it, and
-- the devices an account owner blocked from Account > Sessions.
--
-- Additive only: nullable columns, one new table and its indexes. Written to be
-- safe to run twice.
ALTER TABLE "SessionState" ADD COLUMN IF NOT EXISTS "deviceKey" TEXT;
ALTER TABLE "SessionState" ADD COLUMN IF NOT EXISTS "deviceName" TEXT;

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientDeviceKey" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientOsVersion" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientHost" TEXT;

ALTER TABLE "CliAuthorization" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;
ALTER TABLE "CliAuthorization" ADD COLUMN IF NOT EXISTS "deviceOsVersion" TEXT;

CREATE TABLE IF NOT EXISTS "BlockedDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "os" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlockedDevice_userId_deviceKey_key" ON "BlockedDevice"("userId", "deviceKey");

ALTER TABLE "BlockedDevice" DROP CONSTRAINT IF EXISTS "BlockedDevice_userId_fkey";
ALTER TABLE "BlockedDevice" ADD CONSTRAINT "BlockedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
