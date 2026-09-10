-- A release that stood beside the one before it only for the change-over, and
-- answers to the service's own name. False on every deployment made before.
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "cutover" BOOLEAN NOT NULL DEFAULT false;
