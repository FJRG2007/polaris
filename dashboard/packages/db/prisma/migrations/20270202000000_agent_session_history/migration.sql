-- Agent sessions: the conversation read from the agent's own transcript.
-- Additive. Existing messages keep kind 'text' and no vendor id; the cursor
-- starts empty, so a running session's history is read from the beginning on
-- its next poll.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "transcriptFile" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "transcriptOffset" BIGINT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "transcriptSyncedAt" TIMESTAMP(3);

ALTER TABLE "AgentSessionMessage" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "AgentSessionMessage" ADD COLUMN IF NOT EXISTS "subject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AgentSessionMessage" ADD COLUMN IF NOT EXISTS "ref" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AgentSessionMessage" ADD COLUMN IF NOT EXISTS "vendorId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSessionMessage_sessionId_vendorId_key" ON "AgentSessionMessage"("sessionId", "vendorId");
