-- A cloud account can be connected for an organization rather than for the
-- person connecting it. Additive: every existing account keeps a null column,
-- which is exactly what it was - its owner's own. Reversed by dropping the
-- column, which turns every account back into its owner's.
ALTER TABLE "CloudAccount" ADD COLUMN IF NOT EXISTS "organizationId" UUID;

CREATE INDEX IF NOT EXISTS "CloudAccount_organizationId_idx" ON "CloudAccount"("organizationId");

ALTER TABLE "CloudAccount" DROP CONSTRAINT IF EXISTS "CloudAccount_organizationId_fkey";
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
