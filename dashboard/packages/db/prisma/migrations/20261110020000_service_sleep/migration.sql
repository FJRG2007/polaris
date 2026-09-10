-- Sleep mode: stop a service after a stretch with no requests, start it on the
-- next one. Null on every service before, which keeps it running.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "sleepAfterMinutes" INTEGER;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "asleepSince" TIMESTAMP(3);
