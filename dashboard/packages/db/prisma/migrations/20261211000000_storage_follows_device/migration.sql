-- A storage on the local network follows its device rather than its address.
--
-- A connection remembers who answered at its address (hardware address, SMB
-- server GUID and names), so a NAS whose DHCP lease moved can be found again on
-- the same network, and so the stored password never goes to a different device
-- that picked up the old address.
--
-- Files kept on this server while a storage was not answering are listed, so
-- they can be moved to it once it answers again.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "StorageConnection" ADD COLUMN IF NOT EXISTS "deviceIdentity" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorageFallbackFile" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "localFolder" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageFallbackFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StorageFallbackFile_localFolder_path_key" ON "StorageFallbackFile"("localFolder", "path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StorageFallbackFile_targetId_idx" ON "StorageFallbackFile"("targetId");
