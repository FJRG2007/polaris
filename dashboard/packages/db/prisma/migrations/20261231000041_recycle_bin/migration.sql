-- Recycle bin: a deleted service, project or managed database is marked binned
-- instead of removed. Every existing row starts unbinned, so nothing changes until
-- somebody deletes something. To reverse, drop the columns and indexes.

ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "binnedAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "binnedById" UUID;
CREATE INDEX IF NOT EXISTS "Application_binnedAt_idx" ON "Application"("binnedAt");

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "binnedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "binnedById" UUID;
CREATE INDEX IF NOT EXISTS "Project_binnedAt_idx" ON "Project"("binnedAt");

ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "binnedAt" TIMESTAMP(3);
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "binnedById" UUID;
CREATE INDEX IF NOT EXISTS "ManagedDatabase_binnedAt_idx" ON "ManagedDatabase"("binnedAt");
