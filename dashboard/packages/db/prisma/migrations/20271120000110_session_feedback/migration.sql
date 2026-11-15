-- Feedback routing for Code sessions (apps/web/src/lib/agents/session-feedback.ts):
-- a per-session switch, what was already reported about each pull request, and
-- which fact a message Polaris queued itself reports.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "autoFeedback" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SessionPullFacts" ADD COLUMN IF NOT EXISTS "feedback" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "AgentQueuedPrompt" ADD COLUMN IF NOT EXISTS "feedbackKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentQueuedPrompt_sessionId_feedbackKey_key" ON "AgentQueuedPrompt"("sessionId", "feedbackKey");
