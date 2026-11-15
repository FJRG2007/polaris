-- A UPS and a NAS placed at a Places place can also say which of its rooms they
-- stand in. Additive and re-runnable; reversed by dropping the two columns.
ALTER TABLE "Ups" ADD COLUMN IF NOT EXISTS "roomId" UUID;
ALTER TABLE "StorageConnection" ADD COLUMN IF NOT EXISTS "roomId" UUID;
