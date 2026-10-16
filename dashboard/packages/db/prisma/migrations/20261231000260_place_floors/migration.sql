-- Floors in Places.
--
-- A room's floor was its own word. It becomes a row of its own, so a floor can
-- exist before any room is on it, be renamed once for every room on it, and be
-- named by an automation that keeps pointing at it through a rename.
--
-- Nothing existing is lost: every floor name already used at a place becomes
-- one floor there, each room on it is linked to it, and the room keeps its
-- `floor` name beside the link. Deleting a floor leaves its rooms on none.
--
-- Every statement is written so that running it a second time is a no-op.
--
-- To reverse it: drop the "PlaceRoom_floorId_fkey" constraint, the
-- "PlaceRoom_floorId_idx" index and the "PlaceRoom"."floorId" column, then the
-- "PlaceFloor" table. Every room's floor name is still in "PlaceRoom"."floor".

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlaceFloor" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceFloor_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PlaceRoom" ADD COLUMN IF NOT EXISTS "floorId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlaceFloor_placeId_name_key" ON "PlaceFloor"("placeId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceFloor_installedAppId_idx" ON "PlaceFloor"("installedAppId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlaceRoom_floorId_idx" ON "PlaceRoom"("floorId");

-- AddForeignKey
ALTER TABLE "PlaceFloor" DROP CONSTRAINT IF EXISTS "PlaceFloor_placeId_fkey";
ALTER TABLE "PlaceFloor" ADD CONSTRAINT "PlaceFloor_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceRoom" DROP CONSTRAINT IF EXISTS "PlaceRoom_floorId_fkey";
ALTER TABLE "PlaceRoom" ADD CONSTRAINT "PlaceRoom_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "PlaceFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one floor per name already used at a place.
INSERT INTO "PlaceFloor" ("id", "installedAppId", "placeId", "name", "updatedAt")
SELECT gen_random_uuid(), used."installedAppId", used."placeId", used."floor", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("placeId", "floor") "installedAppId", "placeId", "floor"
    FROM "PlaceRoom"
    WHERE "floor" IS NOT NULL AND "floor" <> ''
    ORDER BY "placeId", "floor", "createdAt"
) AS used
ON CONFLICT ("placeId", "name") DO NOTHING;

-- Backfill: each room linked to the floor of its name.
UPDATE "PlaceRoom" AS room
SET "floorId" = floor."id"
FROM "PlaceFloor" AS floor
WHERE room."floorId" IS NULL
  AND room."floor" IS NOT NULL
  AND floor."placeId" = room."placeId"
  AND floor."name" = room."floor";
