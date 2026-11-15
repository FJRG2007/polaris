-- A Code session's /goal: the finish condition the agent keeps working toward,
-- judged after each turn (apps/web/src/lib/polar/goals.ts). Null is no goal.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "goal" JSONB;
