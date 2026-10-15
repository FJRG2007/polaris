-- Container registries: many per person, optionally held by an organization.
-- Additive: existing logins stay personal and keep matching by host.
ALTER TABLE "RegistryCredential" ADD COLUMN "orgId" UUID;
ALTER TABLE "RegistryCredential" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RegistryCredential" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE "RegistryCredential" ADD COLUMN "lastTestedAt" TIMESTAMP(3);
ALTER TABLE "RegistryCredential" ADD COLUMN "lastTestOk" BOOLEAN;

-- More than one login per host (two Docker Hub accounts, say).
DROP INDEX IF EXISTS "RegistryCredential_ownerId_registry_key";
CREATE INDEX "RegistryCredential_ownerId_registry_idx" ON "RegistryCredential"("ownerId", "registry");
CREATE INDEX "RegistryCredential_orgId_idx" ON "RegistryCredential"("orgId");

ALTER TABLE "RegistryCredential" ADD CONSTRAINT "RegistryCredential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing rows get the kind their host implies.
UPDATE "RegistryCredential" SET "kind" = 'dockerhub' WHERE "registry" = 'docker.io';
UPDATE "RegistryCredential" SET "kind" = 'ghcr' WHERE "registry" = 'ghcr.io';
UPDATE "RegistryCredential" SET "kind" = 'gitlab' WHERE "registry" = 'registry.gitlab.com';
