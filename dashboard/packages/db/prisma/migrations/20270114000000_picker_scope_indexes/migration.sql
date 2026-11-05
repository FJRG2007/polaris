-- Pickers that page projects, environments and marketplace installs by name (the
-- firewall scope target): the keyset (name, id) the pages are ordered and continued
-- on. Additive; dropping the three indexes undoes it.
CREATE INDEX IF NOT EXISTS "Project_name_id_idx" ON "Project"("name", "id");
CREATE INDEX IF NOT EXISTS "Environment_name_id_idx" ON "Environment"("name", "id");
CREATE INDEX IF NOT EXISTS "InstalledApp_ownerId_name_id_idx" ON "InstalledApp"("ownerId", "name", "id");
