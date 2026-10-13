-- Where a service keeps its volumes, chosen from its own screen, and moves Polaris
-- starts by itself to follow that choice. Additive; to reverse, drop the four
-- columns.

ALTER TABLE "Application"
    ADD COLUMN IF NOT EXISTS "storageMode" TEXT,
    ADD COLUMN IF NOT EXISTS "storageConnectionId" UUID,
    ADD COLUMN IF NOT EXISTS "parkPendingSince" TIMESTAMP(3);

ALTER TABLE "StorageMove"
    ADD COLUMN IF NOT EXISTS "auto" BOOLEAN NOT NULL DEFAULT false;

-- The storage sweep reads the services that chose a mode.
CREATE INDEX IF NOT EXISTS "Application_storageMode_idx" ON "Application"("storageMode");
