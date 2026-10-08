-- The keyboard shortcuts an account moved, shared by every app. Null on every
-- row that already exists, which keeps every default - and Mail's own moved
-- keys, read from where Mail kept them until the account saves here.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- column.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "shortcuts" TEXT;
