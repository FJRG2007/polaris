-- A UPS can be placed in a Places place. Nullable, so every existing UPS stays
-- exactly as it was until somebody places it.
ALTER TABLE "Ups" ADD COLUMN "placeId" UUID;

CREATE INDEX "Ups_placeId_idx" ON "Ups"("placeId");
