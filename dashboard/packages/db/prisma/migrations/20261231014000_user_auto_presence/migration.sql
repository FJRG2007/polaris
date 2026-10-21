-- Automatic status: one setting per account, read with defaults when empty.
-- Additive and a no-op when run a second time.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "autoPresence" TEXT NOT NULL DEFAULT '';
