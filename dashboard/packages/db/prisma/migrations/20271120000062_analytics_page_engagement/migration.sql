-- How far down a page view scrolled (0-100) and how long it was open, filled
-- from the tracker's leave beat. Nullable: views before this, and views that
-- never sent one, read as "not measured".
ALTER TABLE "AnalyticsEvent" ADD COLUMN IF NOT EXISTS "scrollPct" INTEGER;
ALTER TABLE "AnalyticsEvent" ADD COLUMN IF NOT EXISTS "engagedMs" INTEGER;
