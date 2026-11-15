-- Scroll depth and time on page folded into the daily rollup, so ranges past the
-- raw window still answer them. Sums and counts, never averages. Days rolled up
-- before this carry zeros and version 0; the ones whose raw rows remain are
-- folded again by the next prune pass.
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "engagedViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "scrollSum" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "scrollViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "deepViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "engagedMsSum" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "timedViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsDay" ADD COLUMN IF NOT EXISTS "rollupVersion" INTEGER NOT NULL DEFAULT 0;
