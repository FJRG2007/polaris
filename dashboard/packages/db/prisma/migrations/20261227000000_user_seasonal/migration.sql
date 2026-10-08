-- Whether an account sees the seasonal decoration and hears the seasonal sounds.
-- Null on every row that already exists, which follows the defaults in code.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- column.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "seasonal" TEXT;
