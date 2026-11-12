-- How a wall panel is drawn (theme, accent, density, background, screensaver).
-- An empty object reads as every default, so existing panels look as they did.
ALTER TABLE "PlacePanel" ADD COLUMN IF NOT EXISTS "style" JSONB NOT NULL DEFAULT '{}';
