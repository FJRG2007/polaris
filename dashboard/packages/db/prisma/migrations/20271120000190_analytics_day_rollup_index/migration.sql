-- The analytics rollup asks, for every day since the oldest visit, whether that
-- day was rolled up yet ("day" and dimension 'total', any site). Without this it
-- was a sequential scan of the whole table per day per tick.
CREATE INDEX IF NOT EXISTS "AnalyticsDay_day_dimension_idx" ON "AnalyticsDay"("day", "dimension");
