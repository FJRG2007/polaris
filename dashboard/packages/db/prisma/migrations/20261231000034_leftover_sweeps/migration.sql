-- What lets two scheduled passes delete what nothing will read again.
--
-- RateLimitCounter.expiresAt: when a counter's window runs out. Null on counters
-- written before this; the pass ages those out by their window start instead.
--
-- StorageMove.copySettledAt: when the copy a failed move left was emptied, or
-- given up on. Null on every existing row, so each failed move's copy is looked
-- at once more.
--
-- StorageMove.copyTriedAt: when the pass first tried to empty that copy. A week
-- of retries is counted from here, so a copy an old failed move left is still
-- tried before it is given up on.
--
-- To reverse, drop the indexes and the columns.

ALTER TABLE "RateLimitCounter" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");
ALTER TABLE "StorageMove" ADD COLUMN IF NOT EXISTS "copySettledAt" TIMESTAMP(3);
ALTER TABLE "StorageMove" ADD COLUMN IF NOT EXISTS "copyTriedAt" TIMESTAMP(3);
