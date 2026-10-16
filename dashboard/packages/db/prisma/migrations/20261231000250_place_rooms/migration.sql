-- Rooms in Places.
--
-- A place's devices can be put in a room ("Kitchen"), and a room on a floor
-- ("Ground floor"), so an automation can be built by where a device is rather
-- than by its name. The floor is the room's own word rather than a table: a
-- house names its floors once, and the screen offers the names already used.
--
-- Nothing existing changes: a device's room is nullable, and every device
-- starts in none. Deleting a room leaves its devices where they were, in none.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceRoom" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "floor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceRoom_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "roomId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceRoom_placeId_idx" ON "PlaceRoom"("placeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceRoom_installedAppId_idx" ON "PlaceRoom"("installedAppId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceDevice_roomId_idx" ON "PlaceDevice"("roomId");

-- AddForeignKey
ALTER TABLE "PlaceRoom" DROP CONSTRAINT IF EXISTS "PlaceRoom_placeId_fkey";
ALTER TABLE "PlaceRoom" ADD CONSTRAINT "PlaceRoom_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceDevice" DROP CONSTRAINT IF EXISTS "PlaceDevice_roomId_fkey";
ALTER TABLE "PlaceDevice" ADD CONSTRAINT "PlaceDevice_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "PlaceRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
