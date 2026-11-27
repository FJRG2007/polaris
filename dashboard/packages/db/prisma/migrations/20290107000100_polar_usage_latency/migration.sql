-- How long each Polar answer took: to its first token and to its end, so the
-- Usage page can show response times per model the way provider consoles do.
--
-- Additive: both columns are nullable and rows before it read null, which the
-- page counts as not timed rather than as zero.
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "firstTokenMs" INTEGER;
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "answerMs" INTEGER;
