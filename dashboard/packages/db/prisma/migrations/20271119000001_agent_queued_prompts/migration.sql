-- Messages typed while a Code session's agent is mid-turn, sent when the turn ends.
CREATE TABLE IF NOT EXISTS "AgentQueuedPrompt" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentQueuedPrompt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentQueuedPrompt_sessionId_createdAt_idx" ON "AgentQueuedPrompt"("sessionId", "createdAt");

ALTER TABLE "AgentQueuedPrompt" DROP CONSTRAINT IF EXISTS "AgentQueuedPrompt_sessionId_fkey";
ALTER TABLE "AgentQueuedPrompt" ADD CONSTRAINT "AgentQueuedPrompt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The last turn's context split by kind, for "/context".
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "contextUsage" JSONB;
