-- AlterTable
ALTER TABLE "StorageConnection" ADD COLUMN     "orgId" UUID,
ALTER COLUMN "ownerId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "StorageConnection_orgId_idx" ON "StorageConnection"("orgId");

-- AddForeignKey
ALTER TABLE "StorageConnection" ADD CONSTRAINT "StorageConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

