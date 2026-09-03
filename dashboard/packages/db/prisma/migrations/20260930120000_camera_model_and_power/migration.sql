-- The camera's model, and how it is powered.
--
-- Both are new questions the add-camera form asks, and both have to answer
-- themselves for every camera that already exists: nobody is going to be sent
-- round the house re-entering settings for cameras that were working yesterday.
--
-- Every statement is written to survive a second run, per the rule in this
-- folder's README - a migration that fails halfway is retried by the entrypoint
-- and has to finish what it started rather than fail again on its own work.

-- AlterTable
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "modelId" TEXT;
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "power" TEXT NOT NULL DEFAULT 'mains';

-- The default is right for every camera that predates this: they were all set
-- up over RTSP or a wired protocol, which is a thing only a camera on a wire can
-- do for long. The exception is the battery profile, which exists precisely for
-- the cameras that are not - one of those defaulting to "plugged in" would put
-- Polaris back to dialling it once a minute, which is the outage sweep emptying
-- a battery that was meant to last months.
--
-- Narrowed to the rows still carrying the default rather than written as a
-- blanket update: a retry re-runs it against a database where nothing later has
-- happened yet, so it lands on exactly the rows the first run was aiming at.
UPDATE "Camera" SET "power" = 'battery' WHERE "vendor" = 'tapo-battery' AND "power" = 'mains';
