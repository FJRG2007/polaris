-- What the agent noted about a repository across runs. Rerunnable.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "learnings" TEXT;
