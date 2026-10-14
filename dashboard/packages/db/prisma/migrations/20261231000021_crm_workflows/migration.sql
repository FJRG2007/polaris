-- CRM workflows: a trigger and the actions it runs, per kind of record on a
-- shelf. Additive; to reverse, drop CrmWorkflow.

CREATE TABLE IF NOT EXISTS "CrmWorkflow" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actions" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hookHash" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "runAsId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmWorkflow_hookHash_key" ON "CrmWorkflow"("hookHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmWorkflow_orgId_object_idx" ON "CrmWorkflow"("orgId", "object");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmWorkflow_userId_object_idx" ON "CrmWorkflow"("userId", "object");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmWorkflow_enabled_nextRunAt_idx" ON "CrmWorkflow"("enabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "CrmWorkflow" DROP CONSTRAINT IF EXISTS "CrmWorkflow_orgId_fkey";
ALTER TABLE "CrmWorkflow" ADD CONSTRAINT "CrmWorkflow_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmWorkflow" DROP CONSTRAINT IF EXISTS "CrmWorkflow_userId_fkey";
ALTER TABLE "CrmWorkflow" ADD CONSTRAINT "CrmWorkflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
