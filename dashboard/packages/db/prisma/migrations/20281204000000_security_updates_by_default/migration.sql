-- Automatic security updates on by default, and what each server is waiting on.
--
-- Additive: every column is new and nullable or defaulted, so a server whose
-- switch somebody already set keeps its state. "updatesChoice" starts null
-- (nobody chose, the only case the once-per-server pass turns updates on); a
-- person's switch records "on" or "off" with its time, and an "off" is kept.

ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "updatesChoice" TEXT;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "updatesChosenAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "updatesArmedAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "pending" INTEGER;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "securityPending" INTEGER;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "reboot" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "rebootAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "rebootNotifiedAt" TIMESTAMP(3);
