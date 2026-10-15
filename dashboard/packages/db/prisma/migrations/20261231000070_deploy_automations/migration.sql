-- Deploy automations: a project's rules that run actions on a schedule, on a
-- call to their webhook, or on a deploy or domain event, and the history of
-- their runs. New tables only; nothing existing changes. To reverse, drop
-- "DeployAutomationRun" and then "DeployAutomation".

CREATE TABLE IF NOT EXISTS "DeployAutomation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "event" TEXT,
    "eventApplicationId" UUID,
    "webhookTokenHash" TEXT,
    "actions" TEXT NOT NULL DEFAULT '[]',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeployAutomation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeployAutomationRun" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "log" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DeployAutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeployAutomation_webhookTokenHash_key" ON "DeployAutomation"("webhookTokenHash");
CREATE INDEX IF NOT EXISTS "DeployAutomation_projectId_idx" ON "DeployAutomation"("projectId");
CREATE INDEX IF NOT EXISTS "DeployAutomation_enabled_nextRunAt_idx" ON "DeployAutomation"("enabled", "nextRunAt");
CREATE INDEX IF NOT EXISTS "DeployAutomationRun_automationId_startedAt_idx" ON "DeployAutomationRun"("automationId", "startedAt");

ALTER TABLE "DeployAutomation" DROP CONSTRAINT IF EXISTS "DeployAutomation_projectId_fkey";
ALTER TABLE "DeployAutomation" ADD CONSTRAINT "DeployAutomation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeployAutomationRun" DROP CONSTRAINT IF EXISTS "DeployAutomationRun_automationId_fkey";
ALTER TABLE "DeployAutomationRun" ADD CONSTRAINT "DeployAutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "DeployAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
