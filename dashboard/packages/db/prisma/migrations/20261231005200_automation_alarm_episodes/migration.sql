-- Alarm history for the Automations threshold trigger: one row per stretch a
-- trigger spent in alarm. A new table only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "AutomationAlarmEpisode" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "startValue" DOUBLE PRECISION NOT NULL,
    "peakValue" DOUBLE PRECISION NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "endValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationAlarmEpisode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationAlarmEpisode_automationId_nodeId_startedAt_key" ON "AutomationAlarmEpisode"("automationId", "nodeId", "startedAt");

CREATE INDEX IF NOT EXISTS "AutomationAlarmEpisode_automationId_startedAt_idx" ON "AutomationAlarmEpisode"("automationId", "startedAt");

CREATE INDEX IF NOT EXISTS "AutomationAlarmEpisode_startedAt_idx" ON "AutomationAlarmEpisode"("startedAt");

ALTER TABLE "AutomationAlarmEpisode" DROP CONSTRAINT IF EXISTS "AutomationAlarmEpisode_automationId_fkey";
ALTER TABLE "AutomationAlarmEpisode" ADD CONSTRAINT "AutomationAlarmEpisode_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
