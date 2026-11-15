-- Core Web Vitals measured by visitors' browsers, one row per page left.
-- Belongs to the visit, so it is pruned with the raw rows at the retention window.
CREATE TABLE IF NOT EXISTS "AnalyticsVital" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "path" TEXT NOT NULL,
    "lcp" DOUBLE PRECISION,
    "inp" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "fcp" DOUBLE PRECISION,
    "ttfb" DOUBLE PRECISION,
    CONSTRAINT "AnalyticsVital_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsVital_siteId_at_idx" ON "AnalyticsVital"("siteId", "at");
CREATE INDEX IF NOT EXISTS "AnalyticsVital_sessionId_idx" ON "AnalyticsVital"("sessionId");

ALTER TABLE "AnalyticsVital" DROP CONSTRAINT IF EXISTS "AnalyticsVital_siteId_fkey";
ALTER TABLE "AnalyticsVital" ADD CONSTRAINT "AnalyticsVital_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsVital" DROP CONSTRAINT IF EXISTS "AnalyticsVital_sessionId_fkey";
ALTER TABLE "AnalyticsVital" ADD CONSTRAINT "AnalyticsVital_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnalyticsSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
