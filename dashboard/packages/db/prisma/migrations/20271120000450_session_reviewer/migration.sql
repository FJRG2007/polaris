-- Reviewer agent for Code session pull requests (U15).
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "sessionReviewer" TEXT;
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "sessionReviewerModel" TEXT;

CREATE TABLE IF NOT EXISTS "SessionReview" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "cli" TEXT NOT NULL,
    "model" TEXT,
    "hostId" UUID,
    "state" TEXT NOT NULL DEFAULT 'running',
    "verdict" TEXT,
    "summary" TEXT,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "fedBack" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "SessionReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SessionReview_sessionId_number_headSha_attempt_key" ON "SessionReview"("sessionId", "number", "headSha", "attempt");
CREATE INDEX IF NOT EXISTS "SessionReview_state_startedAt_idx" ON "SessionReview"("state", "startedAt");

ALTER TABLE "SessionReview" DROP CONSTRAINT IF EXISTS "SessionReview_sessionId_fkey";
ALTER TABLE "SessionReview" ADD CONSTRAINT "SessionReview_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
