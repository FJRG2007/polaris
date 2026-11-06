-- Game servers: the DNS records Polaris wrote for each one, so deleting or
-- renaming a server removes exactly those. New table, no backfill: records
-- written before it existed are found by the sweep's naming rule instead.
CREATE TABLE IF NOT EXISTS "GameDnsRecord" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "zoneId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releaseRequestedAt" TIMESTAMP(3),
    "releaseError" TEXT,

    CONSTRAINT "GameDnsRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GameDnsRecord_zoneId_recordId_key" ON "GameDnsRecord"("zoneId", "recordId");
CREATE INDEX IF NOT EXISTS "GameDnsRecord_installedAppId_idx" ON "GameDnsRecord"("installedAppId");
CREATE INDEX IF NOT EXISTS "GameDnsRecord_releaseRequestedAt_idx" ON "GameDnsRecord"("releaseRequestedAt");
CREATE INDEX IF NOT EXISTS "GameDnsRecord_ownerId_releaseRequestedAt_idx" ON "GameDnsRecord"("ownerId", "releaseRequestedAt");
