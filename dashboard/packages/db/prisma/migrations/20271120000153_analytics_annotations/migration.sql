-- Notes pinned to a moment on a site's traffic chart.
CREATE TABLE IF NOT EXISTS "AnalyticsAnnotation" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsAnnotation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsAnnotation_siteId_at_idx" ON "AnalyticsAnnotation"("siteId", "at");

ALTER TABLE "AnalyticsAnnotation" DROP CONSTRAINT IF EXISTS "AnalyticsAnnotation_siteId_fkey";
ALTER TABLE "AnalyticsAnnotation" ADD CONSTRAINT "AnalyticsAnnotation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
