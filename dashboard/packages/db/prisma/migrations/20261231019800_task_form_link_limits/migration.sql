-- An intake form's link takes the same limits as every other public link: a
-- password, an expiry, a cap (here on submissions), and the address rules.
-- Every column is nullable or defaults to an empty list, which is no
-- restriction, so every existing form keeps accepting exactly what it did.
-- Reversible: drop the six columns.
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "maxSubmissions" INTEGER;
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TaskForm" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
