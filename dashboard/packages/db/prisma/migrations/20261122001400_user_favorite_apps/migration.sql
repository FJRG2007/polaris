-- The apps somebody pinned to the top of the app switcher.
--
-- Nullable with no default and no backfill: null is "has pinned nothing", and
-- the switcher answers it with recent and suggested apps. So this migration
-- changes nobody's switcher.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "favoriteApps" TEXT;
