-- Automations in Places: when something happens at a place, and only if, do
-- these. Plus the last thing each device was seen doing, which is what lets a
-- change fire them exactly once and "on for 30 minutes" be measured at all.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceDeviceObservation" (
    "deviceId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "stateSince" TIMESTAMP(3) NOT NULL,
    "door" TEXT NOT NULL,
    "doorSince" TIMESTAMP(3) NOT NULL,
    "reading" TEXT NOT NULL,
    "readingSince" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlaceDeviceObservation_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceAutomation" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "definition" JSONB NOT NULL,
    "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceAutomationRun" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "firingKey" TEXT NOT NULL,
    "cause" JSONB NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "waitUntil" TIMESTAMP(3),
    "waitDeviceId" UUID,
    "lockedUntil" TIMESTAMP(3),
    "steps" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PlaceAutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceAutomation_installedAppId_enabled_idx" ON "PlaceAutomation"("installedAppId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceAutomation_placeId_idx" ON "PlaceAutomation"("placeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceAutomationRun_automationId_startedAt_idx" ON "PlaceAutomationRun"("automationId", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceAutomationRun_status_dueAt_idx" ON "PlaceAutomationRun"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceAutomationRun_waitDeviceId_idx" ON "PlaceAutomationRun"("waitDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlaceAutomationRun_automationId_firingKey_key" ON "PlaceAutomationRun"("automationId", "firingKey");

-- AddForeignKey
ALTER TABLE "PlaceDeviceObservation" DROP CONSTRAINT IF EXISTS "PlaceDeviceObservation_deviceId_fkey";
ALTER TABLE "PlaceDeviceObservation" ADD CONSTRAINT "PlaceDeviceObservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PlaceDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceAutomation" DROP CONSTRAINT IF EXISTS "PlaceAutomation_placeId_fkey";
ALTER TABLE "PlaceAutomation" ADD CONSTRAINT "PlaceAutomation_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceAutomationRun" DROP CONSTRAINT IF EXISTS "PlaceAutomationRun_automationId_fkey";
ALTER TABLE "PlaceAutomationRun" ADD CONSTRAINT "PlaceAutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "PlaceAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
