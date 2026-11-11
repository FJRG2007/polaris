-- Agent automations move to the central automations: each rule remembers the
-- automation it became, and a run keeps the instructions a step gave it. Two
-- nullable columns; nothing existing changes.
--
-- Running it a second time is a no-op.
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "instructions" TEXT;
ALTER TABLE "AgentAutomation" ADD COLUMN IF NOT EXISTS "movedToId" UUID;
