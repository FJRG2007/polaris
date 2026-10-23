-- A task's public link takes the same limits as every other public link: a
-- password, an expiry, a cap on opens, and the address rules. Every column is
-- nullable or defaults to an empty list, which is no restriction, so every
-- existing link keeps exactly what it allowed. Reversible: drop the six columns.
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "maxViews" INTEGER;
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TaskShare" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
