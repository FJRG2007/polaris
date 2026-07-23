-- Domain health-probe results, so a subdomain that resolves but does not serve
-- is flagged instead of shown as if it works.
ALTER TABLE "Domain" ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "Domain" ADD COLUMN "healthCheckedAt" TIMESTAMP(3);
ALTER TABLE "Domain" ADD COLUMN "healthCode" INTEGER;
ALTER TABLE "Domain" ADD COLUMN "healthLatencyMs" INTEGER;
ALTER TABLE "Domain" ADD COLUMN "healthDetail" TEXT;

-- Watch: CloudWatch-style alarms and their event log. owner/target are bare
-- uuids so an alarm can watch any subject without coupling.
CREATE TABLE "Alarm" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'gt',
    "threshold" DOUBLE PRECISION,
    "forPeriods" INTEGER NOT NULL DEFAULT 2,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'insufficient',
    "breachStreak" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "notifyChannelId" UUID,
    "notifyPeerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Alarm_ownerId_idx" ON "Alarm"("ownerId");

CREATE INDEX "Alarm_enabled_idx" ON "Alarm"("enabled");

CREATE INDEX "Alarm_targetType_targetId_idx" ON "Alarm"("targetType", "targetId");

CREATE TABLE "AlarmEvent" (
    "id" UUID NOT NULL,
    "alarmId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlarmEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlarmEvent_alarmId_createdAt_idx" ON "AlarmEvent"("alarmId", "createdAt");

ALTER TABLE "AlarmEvent" ADD CONSTRAINT "AlarmEvent_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
