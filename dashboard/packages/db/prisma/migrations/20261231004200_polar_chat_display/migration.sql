-- Polar's chat display settings: tokens and cost under each answer, the
-- context bar, and automatic compaction - all on unless the person turns them
-- off - and an index for a chat's own usage total. Columns with defaults and an
-- index only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "showTokens" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "showCost" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "showContextBar" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "autoCompact" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "PolarUsage_threadId_idx" ON "PolarUsage"("threadId");
