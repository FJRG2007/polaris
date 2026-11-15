-- The tracker's options set per site in Polaris, so one tag with only its key is enough.
ALTER TABLE "AnalyticsSite" ADD COLUMN IF NOT EXISTS "trackerOptions" TEXT NOT NULL DEFAULT '{}';
