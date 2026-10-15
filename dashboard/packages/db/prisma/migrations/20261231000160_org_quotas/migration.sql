-- Per-organization caps, set by a platform administrator. Additive: an
-- organization with no row is unlimited, as every existing one already is.
CREATE TABLE IF NOT EXISTS "OrganizationQuota" (
    "orgId" UUID NOT NULL,
    "members" INTEGER,
    "teams" INTEGER,
    "projects" INTEGER,
    "services" INTEGER,
    "databases" INTEGER,
    "cpus" DOUBLE PRECISION,
    "memoryMb" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationQuota_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "OrganizationQuota" DROP CONSTRAINT IF EXISTS "OrganizationQuota_orgId_fkey";
ALTER TABLE "OrganizationQuota" ADD CONSTRAINT "OrganizationQuota_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
