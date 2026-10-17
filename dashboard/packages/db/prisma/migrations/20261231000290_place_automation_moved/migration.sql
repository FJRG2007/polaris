-- A Places automation moved to the central automations engine names its
-- central twin. Additive only: the old row, its runs and its definition stay,
-- and clearing the column hands the row back to the old engine.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceAutomation" ADD COLUMN IF NOT EXISTS "movedToId" UUID;
