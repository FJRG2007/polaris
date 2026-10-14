-- A CRM workflow run that waits for its record to match: until when it waits
-- before giving up. Null on every other run, so existing runs are unchanged.
-- The index finds the runs waiting on a record when that record changes.
-- To reverse, drop the index and the column.

ALTER TABLE "CrmWorkflowRun" ADD COLUMN IF NOT EXISTS "waitUntil" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "CrmWorkflowRun_recordId_status_idx" ON "CrmWorkflowRun"("recordId", "status");
