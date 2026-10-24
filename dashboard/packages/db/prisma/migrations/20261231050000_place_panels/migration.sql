-- Wall panels: additive. No place has a panel until somebody builds one.
CREATE TABLE IF NOT EXISTS "PlacePanel" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cards" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlacePanel_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PlacePanel_installedAppId_placeId_idx" ON "PlacePanel"("installedAppId", "placeId");
ALTER TABLE "PlacePanel" DROP CONSTRAINT IF EXISTS "PlacePanel_placeId_fkey";
ALTER TABLE "PlacePanel" ADD CONSTRAINT "PlacePanel_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;
