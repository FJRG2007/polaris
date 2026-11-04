-- Pickers that page services and UPS units by name: the keyset (name, id) the
-- pages are ordered and continued on. Additive; dropping the two indexes undoes it.
CREATE INDEX IF NOT EXISTS "Application_name_id_idx" ON "Application"("name", "id");
CREATE INDEX IF NOT EXISTS "Ups_name_id_idx" ON "Ups"("name", "id");
