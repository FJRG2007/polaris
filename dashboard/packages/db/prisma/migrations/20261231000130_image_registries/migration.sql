-- Container registries: many per person, optionally held by an organization.
-- Additive: existing logins stay personal and keep matching by host.
ALTER TABLE "RegistryCredential" ADD COLUMN IF NOT EXISTS "orgId" UUID;
ALTER TABLE "RegistryCredential" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RegistryCredential" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE "RegistryCredential" ADD COLUMN IF NOT EXISTS "lastTestedAt" TIMESTAMP(3);
ALTER TABLE "RegistryCredential" ADD COLUMN IF NOT EXISTS "lastTestOk" BOOLEAN;

-- More than one login per host (two Docker Hub accounts, say).
DROP INDEX IF EXISTS "RegistryCredential_ownerId_registry_key";
CREATE INDEX IF NOT EXISTS "RegistryCredential_ownerId_registry_idx" ON "RegistryCredential"("ownerId", "registry");
CREATE INDEX IF NOT EXISTS "RegistryCredential_orgId_idx" ON "RegistryCredential"("orgId");

ALTER TABLE "RegistryCredential" DROP CONSTRAINT IF EXISTS "RegistryCredential_orgId_fkey";
ALTER TABLE "RegistryCredential" ADD CONSTRAINT "RegistryCredential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing rows get the kind their host implies.
UPDATE "RegistryCredential" SET "kind" = 'dockerhub' WHERE "registry" = 'docker.io';
UPDATE "RegistryCredential" SET "kind" = 'ghcr' WHERE "registry" = 'ghcr.io';
UPDATE "RegistryCredential" SET "kind" = 'gitlab' WHERE "registry" = 'registry.gitlab.com';
