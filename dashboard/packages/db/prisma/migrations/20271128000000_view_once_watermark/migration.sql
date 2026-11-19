-- Whether a view-once file carries the reader's name and the time.
--
-- Additive only: two defaulted columns. Every account keeps the watermark on,
-- and every file already sent keeps the one it was sent with.
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "viewOnceWatermark" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "watermark" BOOLEAN NOT NULL DEFAULT true;
