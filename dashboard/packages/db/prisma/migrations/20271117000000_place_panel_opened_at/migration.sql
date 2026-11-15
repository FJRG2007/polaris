-- When a wall last opened a panel, for the panels table. Null reads as never.
ALTER TABLE "PlacePanel" ADD COLUMN IF NOT EXISTS "openedAt" TIMESTAMP(3);
