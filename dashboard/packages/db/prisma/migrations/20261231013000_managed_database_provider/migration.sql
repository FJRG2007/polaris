-- An instance that lives in a cloud instead of on a server. Additive; reverse with
-- ALTER TABLE "ManagedDatabase" DROP COLUMN "provider", DROP COLUMN "providerResourceId", DROP COLUMN "providerError";
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "providerResourceId" TEXT,
ADD COLUMN IF NOT EXISTS "providerError" TEXT;

-- Rows still being created in a cloud are found by the watcher that resumes them.
CREATE INDEX IF NOT EXISTS "ManagedDatabase_provider_status_idx" ON "ManagedDatabase"("provider", "status");
