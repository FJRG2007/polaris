-- A scheduled or reported picture or video keeps the pixel size and ThumbHash
-- its attachment carries, so it is drawn at its final size like one sent now.
--
-- Additive only: three nullable columns on each table, nothing backfilled here.
-- Written to be safe to run twice.
ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "thumbhash" TEXT;
ALTER TABLE "ChatReportFile" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "ChatReportFile" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "ChatReportFile" ADD COLUMN IF NOT EXISTS "thumbhash" TEXT;
