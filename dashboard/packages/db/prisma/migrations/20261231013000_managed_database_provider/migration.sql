-- An instance that lives in a cloud instead of on a server. Additive; reverse with
-- ALTER TABLE "ManagedDatabase" DROP COLUMN "provider", DROP COLUMN "providerResourceId", DROP COLUMN "providerError";
ALTER TABLE "ManagedDatabase" ADD COLUMN "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN "providerResourceId" TEXT,
ADD COLUMN "providerError" TEXT;

-- Rows still being created in a cloud are found by the watcher that resumes them.
CREATE INDEX "ManagedDatabase_provider_status_idx" ON "ManagedDatabase"("provider", "status");
