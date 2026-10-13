-- A waiting CRM workflow run keeps the actions it started with, so editing the
-- workflow while it waits does not change what it goes on to do. Additive; to
-- reverse, drop the column.

ALTER TABLE "CrmWorkflowRun" ADD COLUMN IF NOT EXISTS "actions" TEXT;
