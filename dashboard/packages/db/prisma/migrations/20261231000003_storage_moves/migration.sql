-- Moving a service volume between storage locations (this server, a NAS).
-- Additive only.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorageMove" (
    "id" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "actorId" UUID,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "originLabel" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "wasRunning" BOOLEAN,
    "switched" BOOLEAN NOT NULL DEFAULT false,
    "totalBytes" BIGINT,
    "copiedBytes" BIGINT,
    "fileCount" INTEGER,
    "error" TEXT,
    "originRemoved" BOOLEAN,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StorageMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StorageMove_state_idx" ON "StorageMove"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StorageMove_volumeId_idx" ON "StorageMove"("volumeId");
