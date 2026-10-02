-- Zero-downtime deploys, networks of the operator's own, and careful clean-up on
-- a shared server.
--
-- A service with volumes may be allowed to overlap its change-over; a service may
-- join networks Polaris does not own, under the names it answers to there; a
-- server may be marked as shared, so clean-up there never touches what Polaris
-- did not start; and a deployment records the machine its image was built on.

ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "overlapVolumes" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "externalNetworks" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Host" ADD COLUMN IF NOT EXISTS "sharedHost" BOOLEAN;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "builtOn" TEXT;
