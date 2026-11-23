-- A service's restart policy (Railway's never / on failure / always). "always"
-- is what every service ran with before, so existing rows keep their behaviour.
ALTER TABLE "Application" ADD COLUMN "restartMaxRetries" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "restartPolicy" TEXT NOT NULL DEFAULT 'always';
