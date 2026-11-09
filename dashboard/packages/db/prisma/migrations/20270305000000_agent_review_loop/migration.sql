-- Sessions from issues, session usage, forks, and per-repository setup scripts:
-- additive. Existing automations keep starting runs, existing sessions read as
-- having spent nothing that was counted, and existing repositories run no setup.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: drop the columns added below.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "setupScript" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "setupRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentAutomation" ADD COLUMN IF NOT EXISTS "target" TEXT NOT NULL DEFAULT 'run';

ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "issueNumber" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "parentId" UUID;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "tokensIn" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "tokensOut" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "costUsd" DOUBLE PRECISION;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "usageMessageId" TEXT;
