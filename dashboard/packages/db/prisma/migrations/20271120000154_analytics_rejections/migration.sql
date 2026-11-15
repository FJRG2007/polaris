-- Beats turned away per site, day and cause, for the site's own screen.
CREATE TABLE IF NOT EXISTS "AnalyticsRejection" (
    "siteId" UUID NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "cause" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalyticsRejection_pkey" PRIMARY KEY ("siteId", "day", "cause")
);

CREATE INDEX IF NOT EXISTS "AnalyticsRejection_day_idx" ON "AnalyticsRejection"("day");

ALTER TABLE "AnalyticsRejection" DROP CONSTRAINT IF EXISTS "AnalyticsRejection_siteId_fkey";
ALTER TABLE "AnalyticsRejection" ADD CONSTRAINT "AnalyticsRejection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
