-- AlterTable
ALTER TABLE "Camera" ADD COLUMN     "placeId" UUID;

-- CreateTable
CREATE TABLE "Place" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'house',
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Place_installedAppId_idx" ON "Place"("installedAppId");

-- CreateIndex
CREATE INDEX "Camera_placeId_idx" ON "Camera"("placeId");

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

