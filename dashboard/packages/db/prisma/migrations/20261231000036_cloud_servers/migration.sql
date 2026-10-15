-- The Cloud servers app: connected provider accounts and the servers created
-- through them, and the prices read for them. Additive only. To reverse,
-- drop the three tables.

CREATE TABLE IF NOT EXISTS "CloudAccount" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CloudAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CloudServer" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "ipv4" TEXT,
    "hostId" UUID,
    "enrollmentId" UUID,
    "priceHourly" DOUBLE PRECISION,
    "priceMonthly" DOUBLE PRECISION,
    "currency" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "destroyedAt" TIMESTAMP(3),
    CONSTRAINT "CloudServer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CloudAccount_ownerId_idx" ON "CloudAccount"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "CloudServer_hostId_key" ON "CloudServer"("hostId");
CREATE UNIQUE INDEX IF NOT EXISTS "CloudServer_accountId_providerId_key" ON "CloudServer"("accountId", "providerId");
CREATE INDEX IF NOT EXISTS "CloudServer_ownerId_destroyedAt_idx" ON "CloudServer"("ownerId", "destroyedAt");
CREATE INDEX IF NOT EXISTS "CloudServer_accountId_destroyedAt_idx" ON "CloudServer"("accountId", "destroyedAt");

DO $$ BEGIN
    ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CloudServer" ADD CONSTRAINT "CloudServer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CloudServer" ADD CONSTRAINT "CloudServer_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CloudPrice" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "priceHourly" DOUBLE PRECISION,
    "priceMonthly" DOUBLE PRECISION,
    "currency" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CloudPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CloudPrice_provider_region_size_key" ON "CloudPrice"("provider", "region", "size");
