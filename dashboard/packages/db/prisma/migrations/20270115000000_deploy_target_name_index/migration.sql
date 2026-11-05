-- The security scans server picker pages every deploy target by name: the keyset
-- (name, id) the pages are ordered and continued on. Additive; dropping the index
-- undoes it.
CREATE INDEX IF NOT EXISTS "DeployTarget_name_id_idx" ON "DeployTarget"("name", "id");
