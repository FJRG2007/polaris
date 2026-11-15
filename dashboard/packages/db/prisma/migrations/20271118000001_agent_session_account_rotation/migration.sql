-- A session moving to the next account when one hits its usage limit
-- (`lib/agents/account-rotation.ts`). Additive and rerunnable.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "limitSeq" BIGINT;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "limitWaitUntil" TIMESTAMP(3);
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "limitRetries" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "AgentSession_limitWaitUntil_idx" ON "AgentSession"("limitWaitUntil");
