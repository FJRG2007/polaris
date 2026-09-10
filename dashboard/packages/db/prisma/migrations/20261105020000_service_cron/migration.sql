-- Scheduled jobs for deployed services.
--
-- A command a service runs on a cron schedule inside its own container, with
-- retries and the output of every run kept. Nothing existing changes.
CREATE TABLE IF NOT EXISTS "ServiceCron" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "command" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 900,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "retryDelaySeconds" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "retryAttempt" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCron_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ServiceCronRun" (
    "id" UUID NOT NULL,
    "cronId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "exitCode" INTEGER,
    "output" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceCronRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ServiceCron_applicationId_idx" ON "ServiceCron"("applicationId");
CREATE INDEX IF NOT EXISTS "ServiceCron_enabled_nextRunAt_idx" ON "ServiceCron"("enabled", "nextRunAt");
CREATE INDEX IF NOT EXISTS "ServiceCron_retryAt_idx" ON "ServiceCron"("retryAt");
CREATE INDEX IF NOT EXISTS "ServiceCronRun_cronId_startedAt_idx" ON "ServiceCronRun"("cronId", "startedAt");

ALTER TABLE "ServiceCron" DROP CONSTRAINT IF EXISTS "ServiceCron_applicationId_fkey";
ALTER TABLE "ServiceCron" ADD CONSTRAINT "ServiceCron_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceCronRun" DROP CONSTRAINT IF EXISTS "ServiceCronRun_cronId_fkey";
ALTER TABLE "ServiceCronRun" ADD CONSTRAINT "ServiceCronRun_cronId_fkey" FOREIGN KEY ("cronId") REFERENCES "ServiceCron"("id") ON DELETE CASCADE ON UPDATE CASCADE;
