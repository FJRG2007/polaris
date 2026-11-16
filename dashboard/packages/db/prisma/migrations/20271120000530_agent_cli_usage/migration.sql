-- Usage read from each CLI's own records (apps/web/src/lib/agents/cli-usage.ts)
-- and the usage limits Code sessions hit (lib/agents/limit-history.ts). Rerunnable.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "usageReadAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AgentLimitHit" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "cli" TEXT NOT NULL,
    "accountId" UUID,
    "resetAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentLimitHit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentLimitHit_userId_createdAt_idx" ON "AgentLimitHit"("userId", "createdAt");

ALTER TABLE "AgentLimitHit" DROP CONSTRAINT IF EXISTS "AgentLimitHit_userId_fkey";
ALTER TABLE "AgentLimitHit" ADD CONSTRAINT "AgentLimitHit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
