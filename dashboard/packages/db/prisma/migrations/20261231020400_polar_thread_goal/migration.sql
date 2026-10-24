-- A Polar chat's /goal: the condition it keeps working toward, its turn and
-- time counters, and the newest judgement, as one JSON value. Nullable, so
-- every existing chat reads as having no goal.
-- Reversible: drop the column.
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "goal" JSONB;
