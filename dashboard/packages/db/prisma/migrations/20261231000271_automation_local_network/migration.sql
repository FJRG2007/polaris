-- Per-automation switch that lets its HTTP steps reach private LAN ranges.
-- Off by default; only an administrator may turn it on (enforced in the app).
-- Idempotent. Reversal: ALTER TABLE "Automation" DROP COLUMN IF EXISTS "allowLocalNetwork";
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "allowLocalNetwork" BOOLEAN NOT NULL DEFAULT false;
