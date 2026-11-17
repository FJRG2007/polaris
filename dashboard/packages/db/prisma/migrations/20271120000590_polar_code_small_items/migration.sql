-- Polar Code small items: a repository's standing instructions for its
-- sessions (apps/web/src/lib/agents/session-cues.ts). Rerunnable.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "cues" TEXT NOT NULL DEFAULT '';

-- The command that starts a repository's dev server for the session preview
-- (apps/web/src/lib/agents/session-preview-command.ts).
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "previewCommand" TEXT NOT NULL DEFAULT '';

-- Code sessions a repository starts on a cron schedule
-- (apps/web/src/lib/agents/session-schedules.ts), and one row per firing.
CREATE TABLE IF NOT EXISTS "AgentSessionSchedule" (
    "id" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "cli" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "prompt" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastSessionId" UUID,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentSessionSchedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentSessionSchedule_enabled_nextRunAt_idx" ON "AgentSessionSchedule"("enabled", "nextRunAt");
CREATE INDEX IF NOT EXISTS "AgentSessionSchedule_repoId_idx" ON "AgentSessionSchedule"("repoId");
CREATE INDEX IF NOT EXISTS "AgentSessionSchedule_createdById_idx" ON "AgentSessionSchedule"("createdById");
ALTER TABLE "AgentSessionSchedule" DROP CONSTRAINT IF EXISTS "AgentSessionSchedule_repoId_fkey";
ALTER TABLE "AgentSessionSchedule" ADD CONSTRAINT "AgentSessionSchedule_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AgentRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentSessionSchedule" DROP CONSTRAINT IF EXISTS "AgentSessionSchedule_createdById_fkey";
ALTER TABLE "AgentSessionSchedule" ADD CONSTRAINT "AgentSessionSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentSessionScheduleRun" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "sessionId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSessionScheduleRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentSessionScheduleRun_scheduleId_createdAt_idx" ON "AgentSessionScheduleRun"("scheduleId", "createdAt");
ALTER TABLE "AgentSessionScheduleRun" DROP CONSTRAINT IF EXISTS "AgentSessionScheduleRun_scheduleId_fkey";
ALTER TABLE "AgentSessionScheduleRun" ADD CONSTRAINT "AgentSessionScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "AgentSessionSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
