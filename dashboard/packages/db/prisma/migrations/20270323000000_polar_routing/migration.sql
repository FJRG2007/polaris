-- Polar's router: a provider key that refused is stepped over until it has
-- cooled down, a key may carry its own allowance, every answer records which
-- key paid for it and whether a fallback answered, and a person keeps their
-- own fallback list and coding-tool model map. Additive and idempotent.
-- To reverse: drop the columns added below and the PolarUsage keyId index.

ALTER TABLE "UserModelKey" ADD COLUMN IF NOT EXISTS "coolingUntil" TIMESTAMP(3);
ALTER TABLE "UserModelKey" ADD COLUMN IF NOT EXISTS "coolingReason" TEXT;
ALTER TABLE "UserModelKey" ADD COLUMN IF NOT EXISTS "limits" TEXT NOT NULL DEFAULT '{}';

ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "keyId" UUID;
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "surface" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "fellBackFrom" TEXT;
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "fellBackKind" TEXT;
CREATE INDEX IF NOT EXISTS "PolarUsage_keyId_createdAt_idx" ON "PolarUsage"("keyId", "createdAt");

ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "routing" JSONB;
