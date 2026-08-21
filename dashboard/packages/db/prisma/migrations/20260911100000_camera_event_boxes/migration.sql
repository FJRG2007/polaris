-- AlterTable
ALTER TABLE "CameraEvent" ADD COLUMN     "box" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "trackId" TEXT,
ADD COLUMN     "zones" TEXT NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "CameraEvent_cameraId_trackId_idx" ON "CameraEvent"("cameraId", "trackId");

