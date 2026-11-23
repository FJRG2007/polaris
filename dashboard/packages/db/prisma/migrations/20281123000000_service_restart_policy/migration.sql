-- A service's restart policy (Railway's never / on failure / always). "always"
-- is what every service ran with before, so existing rows keep their behaviour.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "restartMaxRetries" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS "restartPolicy" TEXT NOT NULL DEFAULT 'always';
