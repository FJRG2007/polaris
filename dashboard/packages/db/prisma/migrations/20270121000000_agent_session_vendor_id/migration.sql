-- Agent sessions: the agent's own conversation id and transcript path, as its
-- hooks report them, so a session whose agent exited can reopen that
-- conversation. Nullable, no backfill: a session with none offers no Resume
-- until its next hook arrives.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "vendorSessionId" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "transcriptPath" TEXT;
