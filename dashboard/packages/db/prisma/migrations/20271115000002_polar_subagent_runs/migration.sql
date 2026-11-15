-- Subagents a Polar chat started: their status, steps, transcript and result.
CREATE TABLE IF NOT EXISTS "PolarSubagentRun" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "toolCallId" TEXT,
    "resumedFrom" UUID,
    "kind" TEXT NOT NULL,
    "agentId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "background" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "failure" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "steps" JSONB,
    "messages" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "PolarSubagentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarSubagentRun_threadId_startedAt_idx" ON "PolarSubagentRun"("threadId", "startedAt");
CREATE INDEX IF NOT EXISTS "PolarSubagentRun_userId_status_idx" ON "PolarSubagentRun"("userId", "status");

ALTER TABLE "PolarSubagentRun" DROP CONSTRAINT IF EXISTS "PolarSubagentRun_threadId_fkey";
ALTER TABLE "PolarSubagentRun" ADD CONSTRAINT "PolarSubagentRun_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PolarThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
