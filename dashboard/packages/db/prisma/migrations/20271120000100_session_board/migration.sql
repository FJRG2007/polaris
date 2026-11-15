-- The session board's agent filter reads sessions by tool, newest first.
CREATE INDEX IF NOT EXISTS "AgentSession_cli_createdAt_idx" ON "AgentSession"("cli", "createdAt");

-- A pull request fact that changes wakes the pages watching its session, the
-- board among them, from whichever process wrote it. The notify function is
-- the one `agent_session_live_notify` defined; it reads "sessionId" for any
-- table that is not AgentSession.
DROP TRIGGER IF EXISTS "SessionPullFacts_live_notify" ON "SessionPullFacts";
CREATE TRIGGER "SessionPullFacts_live_notify"
    AFTER INSERT OR UPDATE OR DELETE ON "SessionPullFacts"
    FOR EACH ROW EXECUTE FUNCTION "polaris_agent_session_notify"();
