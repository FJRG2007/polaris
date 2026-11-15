-- Runners on people's own computers, for Polar Code's "This computer" placement
-- (docs/runner-protocol.md). Additive and rerunnable.
CREATE TABLE IF NOT EXISTS "AgentRunner" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "platform" TEXT,
    "osRelease" TEXT,
    "arch" TEXT,
    "runnerVersion" TEXT,
    "capabilities" JSONB,
    "relayNode" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRunner_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRunner_tokenHash_key" ON "AgentRunner"("tokenHash");
CREATE INDEX IF NOT EXISTS "AgentRunner_userId_idx" ON "AgentRunner"("userId");
ALTER TABLE "AgentRunner" DROP CONSTRAINT IF EXISTS "AgentRunner_userId_fkey";
ALTER TABLE "AgentRunner" ADD CONSTRAINT "AgentRunner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentRunnerCommand" (
    "id" UUID NOT NULL,
    "runnerId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunnerCommand_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentRunnerCommand_createdAt_idx" ON "AgentRunnerCommand"("createdAt");

ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "runnerId" UUID;
CREATE INDEX IF NOT EXISTS "AgentSession_runnerId_idx" ON "AgentSession"("runnerId");
