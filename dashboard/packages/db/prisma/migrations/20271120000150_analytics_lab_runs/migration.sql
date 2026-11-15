-- Scheduled Lighthouse audits per site, and the audits themselves.
ALTER TABLE "AnalyticsSite" ADD COLUMN IF NOT EXISTS "labFrequency" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "AnalyticsSite" ADD COLUMN IF NOT EXISTS "labNextAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AnalyticsLabRun" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "performance" INTEGER,
    "accessibility" INTEGER,
    "bestPractices" INTEGER,
    "seo" INTEGER,
    "lcpMs" INTEGER,
    "cls" DOUBLE PRECISION,
    "tbtMs" INTEGER,
    "fcpMs" INTEGER,
    "siMs" INTEGER,
    "ttiMs" INTEGER,
    "lighthouseVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsLabRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsLabRun_siteId_createdAt_idx" ON "AnalyticsLabRun"("siteId", "createdAt");
CREATE INDEX IF NOT EXISTS "AnalyticsLabRun_status_createdAt_idx" ON "AnalyticsLabRun"("status", "createdAt");

ALTER TABLE "AnalyticsLabRun" DROP CONSTRAINT IF EXISTS "AnalyticsLabRun_siteId_fkey";
ALTER TABLE "AnalyticsLabRun" ADD CONSTRAINT "AnalyticsLabRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
