-- The accounts a place's devices are reached through, as a table.
--
-- There was one way in to one make, so the credential for it lived in "Setting"
-- as a single row. A house has more than that: two makes, or one make reached two
-- ways so it still answers when either is out, or two logins because the office
-- and the flat are not the same account. None of that fits in a setting, and all
-- of it is one row here.
--
-- No credential is moved by this migration. The existing one is still in
-- "Setting", encrypted with a key this file does not have and must never see; the
-- first read after the update adopts it into a row here and clears it. That is
-- why "accountId" is nullable: a device that predates this has no account until
-- that adoption runs, and it has to keep working in the meantime.
--
-- IF NOT EXISTS throughout, and every foreign key dropped by name before it is
-- added, so a run that failed partway is finished by running it again.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceDeviceAccount" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "brand" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "statusNote" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceDeviceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceDeviceAccount_installedAppId_idx" ON "PlaceDeviceAccount"("installedAppId");

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "accountId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceDevice_accountId_idx" ON "PlaceDevice"("accountId");

-- DropIndex
-- One device per id per make becomes one device per id per account. The same lock
-- can be on two logins, and a house that connected both should see it under each
-- rather than have the second sync silently overwrite the first. Rows that have
-- not been adopted yet carry a NULL account, and Postgres treats each NULL as
-- distinct, so nothing already here is collapsed into anything else.
DROP INDEX IF EXISTS "PlaceDevice_vendor_externalId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "PlaceDevice_accountId_externalId_key" ON "PlaceDevice"("accountId", "externalId");

-- AddForeignKey
-- Disconnecting an account takes its devices with it, and their history with
-- them: a row nothing can reach is a lock somebody would still press, and keeping
-- months of who-opened-what for an account that has been disconnected is keeping
-- a record of a building Polaris has just been told it has no business with.
ALTER TABLE "PlaceDevice" DROP CONSTRAINT IF EXISTS "PlaceDevice_accountId_fkey";
ALTER TABLE "PlaceDevice" ADD CONSTRAINT "PlaceDevice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlaceDeviceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
