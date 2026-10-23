-- A document link takes the same address rules as every other public link.
-- Each column defaults to an empty list, which is no restriction, so every
-- existing link keeps exactly what it allowed. Reversible: drop the three columns.
ALTER TABLE "OfficeLink" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "OfficeLink" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "OfficeLink" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
