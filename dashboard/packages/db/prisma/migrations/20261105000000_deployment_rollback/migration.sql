-- Instant rollbacks.
--
-- Every successful release is now pinned under an image name of its own, so
-- rolling back runs that image again with nothing fetched or built. These say
-- which releases still have their image on the server (the kept window drops
-- the oldest), which ones somebody asked to keep regardless, and which
-- deployment a rollback went back to.
--
-- Every existing row starts not kept: nothing deployed before this was pinned,
-- so there is no image to roll back to until the next deploy makes one.
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "imageKept" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "rollbackOfId" UUID;
