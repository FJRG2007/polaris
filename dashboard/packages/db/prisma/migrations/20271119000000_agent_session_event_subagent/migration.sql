-- The subagent a session event fired in, its type, and the call id or transcript
-- path that ties a launch to its end, for the Code thread's subagent tree.
ALTER TABLE "AgentSessionEvent" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
ALTER TABLE "AgentSessionEvent" ADD COLUMN IF NOT EXISTS "agentType" TEXT;
ALTER TABLE "AgentSessionEvent" ADD COLUMN IF NOT EXISTS "ref" TEXT;
