-- CreateTable
CREATE TABLE "ScheduledDeletion" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "deleteAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledDeletion_ownerId_idx" ON "ScheduledDeletion"("ownerId");

-- CreateIndex
CREATE INDEX "ScheduledDeletion_connectionId_idx" ON "ScheduledDeletion"("connectionId");

-- CreateIndex
CREATE INDEX "ScheduledDeletion_deleteAt_idx" ON "ScheduledDeletion"("deleteAt");

-- AddForeignKey
ALTER TABLE "ScheduledDeletion" ADD CONSTRAINT "ScheduledDeletion_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
