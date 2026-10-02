-- Clickjacking protection, on by default for every scope. A row saved before this
-- existed takes the column default, so every existing service is protected on the
-- next edge sync without anyone opening the firewall.
ALTER TABLE "WafRule" ADD COLUMN IF NOT EXISTS "frameProtection" BOOLEAN NOT NULL DEFAULT true;
-- Sites allowed to frame the scope anyway, as a JSON array of origins.
ALTER TABLE "WafRule" ADD COLUMN IF NOT EXISTS "frameAncestors" TEXT NOT NULL DEFAULT '[]';
