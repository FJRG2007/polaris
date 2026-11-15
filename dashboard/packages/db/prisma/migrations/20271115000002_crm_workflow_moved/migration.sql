-- A CRM workflow moved to the central automations engine names its central
-- twin. Additive only: the old row, its runs and its versions stay, and
-- clearing the column hands the row back to the CRM's own engine.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "CrmWorkflow" ADD COLUMN IF NOT EXISTS "movedToId" UUID;
