-- The CRM's audit log reads a shelf's events newest first. Additive; to
-- reverse, drop the two indexes.

CREATE INDEX IF NOT EXISTS "CrmEvent_orgId_id_idx" ON "CrmEvent"("orgId", "id");
CREATE INDEX IF NOT EXISTS "CrmEvent_userId_id_idx" ON "CrmEvent"("userId", "id");
