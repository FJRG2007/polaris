-- CreateTable
CREATE TABLE "CameraZone" (
    "id" UUID NOT NULL,
    "cameraId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'watch',
    "points" TEXT NOT NULL,
    "objects" TEXT NOT NULL DEFAULT '[]',
    "inertia" INTEGER NOT NULL DEFAULT 3,
    "loiterSeconds" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CameraZone_cameraId_idx" ON "CameraZone"("cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraZone_cameraId_name_key" ON "CameraZone"("cameraId", "name");

-- AddForeignKey
ALTER TABLE "CameraZone" ADD CONSTRAINT "CameraZone_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

