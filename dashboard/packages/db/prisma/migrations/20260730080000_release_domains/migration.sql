-- A hostname that belongs to one build rather than to the service. The service's
-- own domains stay put and follow whichever release is current; a release domain
-- keeps pointing at the build it was created for, so an older version stays
-- reachable without ever taking over the address people saved.
ALTER TABLE "Domain" ADD COLUMN "deploymentId" UUID;

CREATE INDEX "Domain_deploymentId_idx" ON "Domain"("deploymentId");

-- Whether a release was deployed into a project of its own so it could stand
-- beside the ones around it. Recorded rather than derived from the service's
-- current setting, because it decides which container and which port serve this
-- release - turning the setting off must not move a running version out from
-- under the address that is already serving it.
ALTER TABLE "Deployment" ADD COLUMN "isolated" BOOLEAN NOT NULL DEFAULT false;
