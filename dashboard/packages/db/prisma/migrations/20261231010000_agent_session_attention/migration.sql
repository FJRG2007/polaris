-- When an agent session's owner was told it needs them, and what became of the
-- work in its container when it ended. New nullable columns only; existing rows
-- read as "never told" and "ended before this was recorded", and every statement
-- is a no-op when run a second time.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "waitingNotifiedAt" TIMESTAMP(3);
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "workState" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "workCommits" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "workBranch" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "workError" TEXT;
