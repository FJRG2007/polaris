-- The Containers host picker pages a person's stored Docker connections by name:
-- the keyset (ownerId, name, id) the pages are ordered and continued on. Additive;
-- dropping the index undoes it.
CREATE INDEX IF NOT EXISTS "DockerConnection_ownerId_name_id_idx" ON "DockerConnection"("ownerId", "name", "id");
