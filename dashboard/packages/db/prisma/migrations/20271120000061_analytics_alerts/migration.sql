-- One reader's traffic alerts and periodic summary for one site.
CREATE TABLE IF NOT EXISTS "AnalyticsAlert" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "spikeVisitors" INTEGER,
    "dropVisitors" INTEGER,
    "digest" TEXT NOT NULL DEFAULT 'off',
    "spikeSentAt" TIMESTAMP(3),
    "dropSentAt" TIMESTAMP(3),
    "digestSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsAlert_siteId_userId_key" ON "AnalyticsAlert"("siteId", "userId");
CREATE INDEX IF NOT EXISTS "AnalyticsAlert_userId_idx" ON "AnalyticsAlert"("userId");

ALTER TABLE "AnalyticsAlert" DROP CONSTRAINT IF EXISTS "AnalyticsAlert_siteId_fkey";
ALTER TABLE "AnalyticsAlert" ADD CONSTRAINT "AnalyticsAlert_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
