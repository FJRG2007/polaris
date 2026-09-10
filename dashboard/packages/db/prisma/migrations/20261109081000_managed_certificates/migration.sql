-- Where an owner domain's zone is hosted, and the token that writes its DNS-01
-- challenge (encrypted at rest). Null means the instance's own token.
ALTER TABLE "OwnerDomain" ADD COLUMN IF NOT EXISTS "dnsProvider" TEXT;
ALTER TABLE "OwnerDomain" ADD COLUMN IF NOT EXISTS "dnsToken" TEXT;

-- Wildcard certificates Polaris orders over DNS-01 and keeps renewed.
CREATE TABLE IF NOT EXISTS "ManagedCertificate" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ownerDomainId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "certPem" TEXT,
    "certKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedCertificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ManagedCertificate_domain_key" ON "ManagedCertificate"("domain");
CREATE INDEX IF NOT EXISTS "ManagedCertificate_ownerDomainId_idx" ON "ManagedCertificate"("ownerDomainId");

ALTER TABLE "ManagedCertificate" DROP CONSTRAINT IF EXISTS "ManagedCertificate_ownerDomainId_fkey";
ALTER TABLE "ManagedCertificate" ADD CONSTRAINT "ManagedCertificate_ownerDomainId_fkey" FOREIGN KEY ("ownerDomainId") REFERENCES "OwnerDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
