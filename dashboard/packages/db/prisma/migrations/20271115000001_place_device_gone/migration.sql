-- A device its account stopped listing is kept, off limits, instead of deleted.
-- Additive and re-runnable; reversed by dropping the two columns.
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "goneAt" TIMESTAMP(3);
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMP(3);
