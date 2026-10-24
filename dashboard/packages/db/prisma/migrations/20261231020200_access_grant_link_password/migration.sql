-- A link may ask for a password before it opens. Nullable, so every existing
-- link keeps opening without one; reversed by dropping the column.
ALTER TABLE "AccessGrant" ADD COLUMN IF NOT EXISTS "linkPasswordHash" TEXT;
