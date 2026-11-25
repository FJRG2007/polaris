-- The host firewall each server has, as last read or set, and what a person chose.
--
-- Additive: new columns with defaults, so every existing row reads as "not read
-- yet" and "nobody chose" until the next pass reads the server.
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewall" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallChoice" TEXT;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallChosenAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallKeep" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallOpen" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallClosing" INTEGER;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "firewallNotifiedAt" TIMESTAMP(3);
