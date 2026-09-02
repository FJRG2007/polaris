-- AlterTable
ALTER TABLE "UserPrivacy" ADD COLUMN     "fileTransfers" TEXT NOT NULL DEFAULT 'friends';

-- CreateTable
CREATE TABLE "DriveTransfer" (
    "id" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isFolder" BOOLEAN NOT NULL DEFAULT false,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL DEFAULT 'copy',
    "note" TEXT,
    "recipientId" UUID,
    "recipientOrg" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "landedPath" TEXT,
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriveTransfer_recipientId_status_idx" ON "DriveTransfer"("recipientId", "status");

-- CreateIndex
CREATE INDEX "DriveTransfer_recipientOrg_status_idx" ON "DriveTransfer"("recipientOrg", "status");

-- CreateIndex
CREATE INDEX "DriveTransfer_senderId_status_idx" ON "DriveTransfer"("senderId", "status");

-- CreateIndex
CREATE INDEX "DriveTransfer_expiresAt_idx" ON "DriveTransfer"("expiresAt");

-- AddForeignKey
ALTER TABLE "DriveTransfer" ADD CONSTRAINT "DriveTransfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveTransfer" ADD CONSTRAINT "DriveTransfer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveTransfer" ADD CONSTRAINT "DriveTransfer_recipientOrg_fkey" FOREIGN KEY ("recipientOrg") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveTransfer" ADD CONSTRAINT "DriveTransfer_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

