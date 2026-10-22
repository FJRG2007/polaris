-- Camera rooms and camera sets: additive. Every existing camera is in no room,
-- and there are no sets until somebody makes one.
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "roomId" UUID;
CREATE INDEX IF NOT EXISTS "Camera_roomId_idx" ON "Camera"("roomId");
ALTER TABLE "Camera" DROP CONSTRAINT IF EXISTS "Camera_roomId_fkey";
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "PlaceRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "CameraSet" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cameraIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraSet_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CameraSet_installedAppId_placeId_idx" ON "CameraSet"("installedAppId", "placeId");
ALTER TABLE "CameraSet" DROP CONSTRAINT IF EXISTS "CameraSet_placeId_fkey";
ALTER TABLE "CameraSet" ADD CONSTRAINT "CameraSet_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;
