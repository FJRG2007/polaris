-- Ceilings on how much agent work something may do.
--
-- Set by an administrator: the money is the deployment's, and a limit the
-- person spending it can raise is not one. Every rule that applies to a run has
-- to be under its ceiling, so the most restrictive wins without anything having
-- to rank them.
CREATE TABLE "AgentUsageLimit" (
    "id" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentUsageLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentUsageLimit_subjectType_subjectId_metric_period_key"
    ON "AgentUsageLimit"("subjectType", "subjectId", "metric", "period");
CREATE INDEX "AgentUsageLimit_subjectType_idx" ON "AgentUsageLimit"("subjectType");
