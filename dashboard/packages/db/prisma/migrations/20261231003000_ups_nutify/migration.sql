-- UPS energy, events, actions and settings. Additive only: new nullable or
-- defaulted columns and three new tables, so every existing UPS keeps working
-- and gets the defaults.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "lastFlags" TEXT;
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "commLostAt" TIMESTAMP(3);
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "pricePerKwh" DOUBLE PRECISION;
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "nominalPowerW" INTEGER;
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "notifyKinds" TEXT[] DEFAULT ARRAY['ONBATT', 'LOWBATT', 'ONLINE', 'REPLBATT', 'TEST', 'COMMBAD', 'FSD', 'SHUTDOWN', 'OVERLOAD']::TEXT[];
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "variableMap" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "reportSchedule" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "reportLastAt" TIMESTAMP(3);
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "netserverEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UpsSample" ADD COLUMN IF NOT EXISTS "inputHz" DOUBLE PRECISION;
ALTER TABLE "UpsSample" ADD COLUMN IF NOT EXISTS "outputV" DOUBLE PRECISION;
ALTER TABLE "UpsSample" ADD COLUMN IF NOT EXISTS "batteryV" DOUBLE PRECISION;
ALTER TABLE "UpsSample" ADD COLUMN IF NOT EXISTS "powerW" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE IF NOT EXISTS "UpsEvent" (
    "id" UUID NOT NULL,
    "upsId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,

    CONSTRAINT "UpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UpsEnergyHour" (
    "upsId" UUID NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "wh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,

    CONSTRAINT "UpsEnergyHour_pkey" PRIMARY KEY ("upsId","hour")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UpsAction" (
    "id" UUID NOT NULL,
    "upsId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "UpsAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UpsEvent_upsId_ts_idx" ON "UpsEvent"("upsId", "ts");
CREATE INDEX IF NOT EXISTS "UpsEvent_ts_idx" ON "UpsEvent"("ts");
CREATE INDEX IF NOT EXISTS "UpsEnergyHour_hour_idx" ON "UpsEnergyHour"("hour");
CREATE INDEX IF NOT EXISTS "UpsAction_upsId_ts_idx" ON "UpsAction"("upsId", "ts");
CREATE INDEX IF NOT EXISTS "UpsAction_ts_idx" ON "UpsAction"("ts");

-- AddForeignKey
ALTER TABLE "UpsEvent" DROP CONSTRAINT IF EXISTS "UpsEvent_upsId_fkey";
ALTER TABLE "UpsEvent" ADD CONSTRAINT "UpsEvent_upsId_fkey" FOREIGN KEY ("upsId") REFERENCES "Ups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UpsEnergyHour" DROP CONSTRAINT IF EXISTS "UpsEnergyHour_upsId_fkey";
ALTER TABLE "UpsEnergyHour" ADD CONSTRAINT "UpsEnergyHour_upsId_fkey" FOREIGN KEY ("upsId") REFERENCES "Ups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UpsAction" DROP CONSTRAINT IF EXISTS "UpsAction_upsId_fkey";
ALTER TABLE "UpsAction" ADD CONSTRAINT "UpsAction_upsId_fkey" FOREIGN KEY ("upsId") REFERENCES "Ups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
