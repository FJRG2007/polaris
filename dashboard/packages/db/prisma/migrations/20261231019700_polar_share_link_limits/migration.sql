-- A shared Polar chat's link takes the same limits as every other public link:
-- a password, an expiry, a cap on opens, and the address rules, plus the count
-- of opens the cap is measured against. Every column is nullable or defaults to
-- no restriction, so every existing link keeps exactly what it allowed.
-- Reversible: drop the seven columns.
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "maxViews" INTEGER;
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "views" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
