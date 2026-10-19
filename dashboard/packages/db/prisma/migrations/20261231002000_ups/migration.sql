-- UPSes Polaris watches, and a reading a minute of each. Additive only: two new
-- tables, nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Ups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "machineId" UUID,
    "deviceId" TEXT,
    "host" TEXT,
    "port" INTEGER,
    "upsName" TEXT,
    "username" TEXT,
    "snmpVersion" TEXT,
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "shutdownEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shutdownBelowCharge" INTEGER,
    "shutdownBelowRuntimeMin" INTEGER,
    "protectedMachineIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "shutdownSentAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastTestResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UpsSample" (
    "upsId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "charge" DOUBLE PRECISION,
    "runtimeS" DOUBLE PRECISION,
    "load" DOUBLE PRECISION,
    "inputV" DOUBLE PRECISION,

    CONSTRAINT "UpsSample_pkey" PRIMARY KEY ("upsId","ts")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UpsSample_ts_idx" ON "UpsSample"("ts");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "UpsSample" ADD CONSTRAINT "UpsSample_upsId_fkey" FOREIGN KEY ("upsId") REFERENCES "Ups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
