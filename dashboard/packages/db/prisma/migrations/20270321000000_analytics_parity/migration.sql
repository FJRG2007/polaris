-- Analytics parity: per-site exclusions, identified visitors, saved reports.
-- Idempotent: every statement can run twice.

ALTER TABLE "AnalyticsSite" ADD COLUMN IF NOT EXISTS "excludedPaths" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "AnalyticsSite" ADD COLUMN IF NOT EXISTS "ignoredIps" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "distinctId" TEXT;
ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "data" TEXT;

CREATE INDEX IF NOT EXISTS "AnalyticsSession_siteId_lastSeenAt_idx" ON "AnalyticsSession"("siteId", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "AnalyticsSession_siteId_distinctId_idx" ON "AnalyticsSession"("siteId", "distinctId");

CREATE TABLE IF NOT EXISTS "AnalyticsReport" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsReport_siteId_kind_idx" ON "AnalyticsReport"("siteId", "kind");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AnalyticsReport_siteId_fkey') THEN
        ALTER TABLE "AnalyticsReport" ADD CONSTRAINT "AnalyticsReport_siteId_fkey"
            FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
