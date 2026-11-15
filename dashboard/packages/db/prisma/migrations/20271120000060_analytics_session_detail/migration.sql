-- UTM term / content and browser / system versions on a visit. Nullable, so
-- the visits recorded before this read as "not recorded".
ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "term" TEXT;
ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "content" TEXT;
ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "browserVersion" TEXT;
ALTER TABLE "AnalyticsSession" ADD COLUMN IF NOT EXISTS "osVersion" TEXT;
