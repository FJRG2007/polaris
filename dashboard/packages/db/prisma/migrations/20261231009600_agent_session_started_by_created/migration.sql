-- Polar's Code history reads one person's own sessions, newest first, a page at
-- a time. An index only; nothing existing changes, and it is a no-op when run a
-- second time.
CREATE INDEX IF NOT EXISTS "AgentSession_startedById_createdAt_idx" ON "AgentSession"("startedById", "createdAt");
