-- SSH sign-in on each server, as last read, and what a person chose.
--
-- Additive: new columns with defaults, so every existing row reads as "not read
-- yet" and "nobody chose" until the next pass reads the server.
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "ssh" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshHardened" BOOLEAN;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshBlocked" TEXT;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshChoice" TEXT;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshChosenAt" TIMESTAMP(3);
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "sshNotifiedAt" TIMESTAMP(3);
