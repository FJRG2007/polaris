-- Looking after managed databases once they exist, an object store beside them,
-- and serving a domain through Cloudflare's cache.
--
-- Every column added to an existing table defaults to what an existing row has
-- always meant: Redis in its default mode, MongoDB standalone, no point-in-time
-- archive, no upgrade asked for, a domain not proxied. Nothing an installed
-- Polaris runs changes because these exist.

ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "maxMemoryMb" INTEGER;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "replicaSet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "pitr" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "pitrKeepDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "upgradeTo" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "upgradeAt" TIMESTAMP(3);
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "upgradeState" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "upgradeError" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "previousVersion" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "previousImage" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "previousVolumeName" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "recoveredFromId" UUID;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "recoveryBase" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "recoveryTarget" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ManagedDatabase_upgradeState_upgradeAt_idx" ON "ManagedDatabase"("upgradeState", "upgradeAt");

ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "cdn" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "DatabaseBaseBackup" (
    "id" UUID NOT NULL,
    "databaseId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "historyFile" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "DatabaseBaseBackup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DatabaseBaseBackup_databaseId_label_key" ON "DatabaseBaseBackup"("databaseId", "label");
CREATE INDEX IF NOT EXISTS "DatabaseBaseBackup_databaseId_finishedAt_idx" ON "DatabaseBaseBackup"("databaseId", "finishedAt");
ALTER TABLE "DatabaseBaseBackup" DROP CONSTRAINT IF EXISTS "DatabaseBaseBackup_databaseId_fkey";
ALTER TABLE "DatabaseBaseBackup" ADD CONSTRAINT "DatabaseBaseBackup_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "DatabaseOperation" (
    "id" UUID NOT NULL,
    "databaseId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" TEXT NOT NULL DEFAULT '',
    "doneBytes" BIGINT NOT NULL DEFAULT 0,
    "totalBytes" BIGINT,
    "error" TEXT,
    "actorId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DatabaseOperation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DatabaseOperation_databaseId_startedAt_idx" ON "DatabaseOperation"("databaseId", "startedAt");
ALTER TABLE "DatabaseOperation" DROP CONSTRAINT IF EXISTS "DatabaseOperation_databaseId_fkey";
ALTER TABLE "DatabaseOperation" ADD CONSTRAINT "DatabaseOperation_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ObjectBucket" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT '[]',
    "replicateToId" UUID,
    "replicationState" TEXT NOT NULL DEFAULT '',
    "replicationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObjectBucket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectBucket_storeId_name_key" ON "ObjectBucket"("storeId", "name");
ALTER TABLE "ObjectBucket" DROP CONSTRAINT IF EXISTS "ObjectBucket_storeId_fkey";
ALTER TABLE "ObjectBucket" ADD CONSTRAINT "ObjectBucket_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ObjectBucketKey" (
    "id" UUID NOT NULL,
    "bucketId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'readwrite',
    "accessKey" TEXT NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObjectBucketKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectBucketKey_accessKey_key" ON "ObjectBucketKey"("accessKey");
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectBucketKey_bucketId_name_key" ON "ObjectBucketKey"("bucketId", "name");
ALTER TABLE "ObjectBucketKey" DROP CONSTRAINT IF EXISTS "ObjectBucketKey_bucketId_fkey";
ALTER TABLE "ObjectBucketKey" ADD CONSTRAINT "ObjectBucketKey_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "ObjectBucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
