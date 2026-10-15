-- Restore points: one configuration object's JSON as it was just before Polaris
-- changed it. New table only; to reverse, drop it.

CREATE TABLE IF NOT EXISTS "RestorePoint" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'change',
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RestorePoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RestorePoint_kind_objectKey_createdAt_idx" ON "RestorePoint"("kind", "objectKey", "createdAt");
CREATE INDEX IF NOT EXISTS "RestorePoint_createdAt_idx" ON "RestorePoint"("createdAt");
