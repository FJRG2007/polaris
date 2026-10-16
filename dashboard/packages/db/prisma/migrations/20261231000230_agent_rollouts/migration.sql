-- Staged agent rollouts and the offline command queue. Additive.
CREATE TABLE IF NOT EXISTS "ServerAgent" (
    "serverId" TEXT NOT NULL,
    "version" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "pinnedVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServerAgent_pkey" PRIMARY KEY ("serverId")
);

CREATE TABLE IF NOT EXISTS "AgentRollout" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "previousVersion" TEXT,
    "waves" TEXT NOT NULL DEFAULT '[1,10,50,100]',
    "healthMinutes" INTEGER NOT NULL DEFAULT 10,
    "status" TEXT NOT NULL DEFAULT 'running',
    "wave" INTEGER NOT NULL DEFAULT 0,
    "haltReason" TEXT,
    "actorId" UUID,
    "openKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AgentRollout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentRollout_openKey_key" ON "AgentRollout"("openKey");
CREATE INDEX IF NOT EXISTS "AgentRollout_status_idx" ON "AgentRollout"("status");

CREATE TABLE IF NOT EXISTS "AgentRolloutTarget" (
    "id" UUID NOT NULL,
    "rolloutId" UUID NOT NULL,
    "serverId" TEXT NOT NULL,
    "wave" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "fromVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "healthySince" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    CONSTRAINT "AgentRolloutTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentRolloutTarget_rolloutId_serverId_key" ON "AgentRolloutTarget"("rolloutId", "serverId");
CREATE INDEX IF NOT EXISTS "AgentRolloutTarget_rolloutId_wave_idx" ON "AgentRolloutTarget"("rolloutId", "wave");

ALTER TABLE "AgentRolloutTarget" DROP CONSTRAINT IF EXISTS "AgentRolloutTarget_rolloutId_fkey";
ALTER TABLE "AgentRolloutTarget" ADD CONSTRAINT "AgentRolloutTarget_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES "AgentRollout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ServerCommand" (
    "id" UUID NOT NULL,
    "serverId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "actorId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "result" TEXT,
    CONSTRAINT "ServerCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ServerCommand_serverId_status_createdAt_idx" ON "ServerCommand"("serverId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "ServerCommand_status_expiresAt_idx" ON "ServerCommand"("status", "expiresAt");
