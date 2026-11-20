-- A picture or video in chat keeps its pixel size and a ThumbHash placeholder,
-- so a reader draws the bubble at its final size, blurred, before the bytes come.
--
-- Additive only: three nullable columns, nothing backfilled (older files fall
-- back to a neutral box). Written to be safe to run twice.
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "thumbhash" TEXT;
