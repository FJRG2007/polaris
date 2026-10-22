-- Image scans by image id: every image a server runs, grouped by its id so one
-- image behind several containers is scanned once, and who runs it.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "SecurityScan" ADD COLUMN IF NOT EXISTS "imageId" TEXT;
ALTER TABLE "SecurityScan" ADD COLUMN IF NOT EXISTS "source" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityScan_targetId_imageId_createdAt_idx" ON "SecurityScan"("targetId", "imageId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityScan_source_createdAt_idx" ON "SecurityScan"("source", "createdAt" DESC);
