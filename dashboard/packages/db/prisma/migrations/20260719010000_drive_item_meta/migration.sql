-- CreateTable
CREATE TABLE "DriveItemMeta" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "icon" TEXT,
    "iconColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveItemMeta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriveItemMeta_ownerId_idx" ON "DriveItemMeta"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "DriveItemMeta_connectionId_path_key" ON "DriveItemMeta"("connectionId", "path");

-- AddForeignKey
ALTER TABLE "DriveItemMeta" ADD CONSTRAINT "DriveItemMeta_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
