-- AlterTable
ALTER TABLE "ChatChannel" ADD COLUMN     "categoryId" UUID;

-- CreateTable
CREATE TABLE "ChatCategory" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatCategory_spaceId_order_idx" ON "ChatCategory"("spaceId", "order");

-- CreateIndex
CREATE INDEX "ChatChannel_categoryId_order_idx" ON "ChatChannel"("categoryId", "order");

-- AddForeignKey
ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChatCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCategory" ADD CONSTRAINT "ChatCategory_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

