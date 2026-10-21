-- The pull request opened from an agent session's branch. New nullable columns
-- only; existing sessions read as "no pull request yet", and every statement is
-- a no-op when run a second time.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "prNumber" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "prUrl" TEXT;
