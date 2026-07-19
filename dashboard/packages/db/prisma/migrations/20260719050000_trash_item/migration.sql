-- CreateTable
CREATE TABLE "TrashItem" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "trashPath" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrashItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrashItem_ownerId_idx" ON "TrashItem"("ownerId");

-- CreateIndex
CREATE INDEX "TrashItem_connectionId_idx" ON "TrashItem"("connectionId");

-- AddForeignKey
ALTER TABLE "TrashItem" ADD CONSTRAINT "TrashItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
