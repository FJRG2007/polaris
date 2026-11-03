-- A server picker reads a page of one account's servers in name order.
CREATE INDEX IF NOT EXISTS "Host_ownerId_name_id_idx" ON "Host"("ownerId", "name", "id");
