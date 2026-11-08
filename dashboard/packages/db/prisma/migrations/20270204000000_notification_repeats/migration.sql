-- Repeated alerts fold into one row: additive. Existing rows keep a null key,
-- a count of one and a null first-seen time, which is exactly what an alert
-- that never repeated has. Nothing existing is rewritten or removed.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP INDEX "Notification_userId_dedupKey_key"; then drop the
-- three columns; and ALTER TABLE "Camera" DROP COLUMN "offlineReportedAt".
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "repeatCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "firstSeenAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_dedupKey_key" ON "Notification"("userId", "dedupKey");

-- The outage a camera was last reported for, so clearing the outage line from
-- the events log no longer reads as "never reported".
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "offlineReportedAt" TIMESTAMP(3);
