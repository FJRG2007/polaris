-- Tasks two-way link (U16b): a run started from Tasks writes its workers into a
-- list, and an item's status follows its session until a person moves it.
ALTER TABLE "AgentOrchestrationRun" ADD COLUMN IF NOT EXISTS "taskListId" UUID;

CREATE TABLE IF NOT EXISTS "TaskAgentLink" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sessionId" UUID,
    "runId" UUID,
    "orchestrationTaskId" UUID,
    "appliedStatusId" UUID,
    "lastStatus" TEXT,
    "held" BOOLEAN NOT NULL DEFAULT false,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskAgentLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TaskAgentLink_orchestrationTaskId_key" ON "TaskAgentLink"("orchestrationTaskId");
CREATE INDEX IF NOT EXISTS "TaskAgentLink_settled_updatedAt_idx" ON "TaskAgentLink"("settled", "updatedAt");
CREATE INDEX IF NOT EXISTS "TaskAgentLink_itemId_idx" ON "TaskAgentLink"("itemId");
CREATE INDEX IF NOT EXISTS "TaskAgentLink_sessionId_idx" ON "TaskAgentLink"("sessionId");
CREATE INDEX IF NOT EXISTS "TaskAgentLink_runId_idx" ON "TaskAgentLink"("runId");
