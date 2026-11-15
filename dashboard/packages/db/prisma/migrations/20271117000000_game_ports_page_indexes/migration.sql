-- The Ports page reads game servers one keyset page at a time, by name or by
-- newest, so each order has an index to walk instead of a sort over the table.
CREATE INDEX IF NOT EXISTS "InstalledApp_name_id_idx" ON "InstalledApp"("name", "id");
CREATE INDEX IF NOT EXISTS "InstalledApp_createdAt_id_idx" ON "InstalledApp"("createdAt", "id");
