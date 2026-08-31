-- CreateTable
CREATE TABLE "TaskTracker" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "spaceId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "config" TEXT NOT NULL DEFAULT '{}',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pushStatus" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTrackerLink" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "issueKey" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "issueUrl" TEXT NOT NULL DEFAULT '',
    "remoteStatus" TEXT NOT NULL DEFAULT '',
    "pushedStatus" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTrackerLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskTracker_ownerId_idx" ON "TaskTracker"("ownerId");

-- CreateIndex
CREATE INDEX "TaskTracker_spaceId_idx" ON "TaskTracker"("spaceId");

-- CreateIndex
CREATE INDEX "TaskTrackerLink_trackerId_idx" ON "TaskTrackerLink"("trackerId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTrackerLink_trackerId_issueKey_key" ON "TaskTrackerLink"("trackerId", "issueKey");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTrackerLink_taskId_key" ON "TaskTrackerLink"("taskId");

-- AddForeignKey
ALTER TABLE "TaskTracker" ADD CONSTRAINT "TaskTracker_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTrackerLink" ADD CONSTRAINT "TaskTrackerLink_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "TaskTracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTrackerLink" ADD CONSTRAINT "TaskTrackerLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

