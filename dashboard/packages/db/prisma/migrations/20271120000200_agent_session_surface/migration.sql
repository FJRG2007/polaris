-- How a Code session's conversation is held: its agent's terminal (the
-- default, and every existing session) or Polaris's chat over the Agent Client
-- Protocol (lib/agents/acp/providers.ts).
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "surface" TEXT NOT NULL DEFAULT 'terminal';
