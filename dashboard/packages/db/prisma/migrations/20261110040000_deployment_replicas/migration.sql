-- How many copies a release was started with, so the edge dials the copies that
-- are running rather than a count set a moment ago. Null on every deployment made
-- before, which reads as the service's own count.
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "replicas" INTEGER;
