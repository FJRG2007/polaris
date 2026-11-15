-- How hard a Code session thinks (Claude Code's --effort). Null is the tool's own default.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "effort" TEXT;
