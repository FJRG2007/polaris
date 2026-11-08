-- Agent orchestration: runs, their tasks and their inbox. Additive: three new
-- tables, nothing existing is touched. A session's new `queued` state is a value
-- of the existing text column and needs no change here.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "AgentOrchestrationMessage", "AgentOrchestrationTask",
-- "AgentOrchestrationRun".
CREATE TABLE IF NOT EXISTS "AgentOrchestrationRun" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "objective" TEXT NOT NULL,
    "repoId" UUID NOT NULL,
    "baseRef" TEXT NOT NULL DEFAULT '',
    "cli" TEXT NOT NULL DEFAULT 'claude',
    "coordinatorSessionId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxTasks" INTEGER NOT NULL DEFAULT 20,
    "maxDepth" INTEGER NOT NULL DEFAULT 4,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AgentOrchestrationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentOrchestrationRun_ownerId_createdAt_idx" ON "AgentOrchestrationRun"("ownerId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentOrchestrationRun_coordinatorSessionId_idx" ON "AgentOrchestrationRun"("coordinatorSessionId");
CREATE INDEX IF NOT EXISTS "AgentOrchestrationRun_status_idx" ON "AgentOrchestrationRun"("status");

CREATE TABLE IF NOT EXISTS "AgentOrchestrationTask" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "blockedBy" TEXT,
    "cli" TEXT,
    "sessionId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "result" TEXT,
    "groupId" UUID,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "gateQuestion" TEXT,
    "gateOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gateResolution" TEXT,
    "gateResolvedBy" UUID,
    "gateResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AgentOrchestrationTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentOrchestrationTask_runId_createdAt_idx" ON "AgentOrchestrationTask"("runId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentOrchestrationTask_sessionId_idx" ON "AgentOrchestrationTask"("sessionId");
CREATE INDEX IF NOT EXISTS "AgentOrchestrationTask_status_idx" ON "AgentOrchestrationTask"("status");

CREATE TABLE IF NOT EXISTS "AgentOrchestrationMessage" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "taskId" UUID,
    "fromSession" UUID,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentOrchestrationMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentOrchestrationMessage_runId_createdAt_idx" ON "AgentOrchestrationMessage"("runId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentOrchestrationMessage_kind_answeredAt_idx" ON "AgentOrchestrationMessage"("kind", "answeredAt");

DO $$ BEGIN
    ALTER TABLE "AgentOrchestrationTask" ADD CONSTRAINT "AgentOrchestrationTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentOrchestrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "AgentOrchestrationMessage" ADD CONSTRAINT "AgentOrchestrationMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentOrchestrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
