-- A CRM workflow's runs: the log the editor shows, and the runs waiting out a
-- delay. Additive; to reverse, drop the table.

CREATE TABLE IF NOT EXISTS "CrmWorkflowRun" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "recordId" UUID,
    "error" TEXT,
    "step" INTEGER NOT NULL DEFAULT 0,
    "resumeAt" TIMESTAMP(3),
    "body" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CrmWorkflowRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmWorkflowRun_workflowId_startedAt_idx" ON "CrmWorkflowRun"("workflowId", "startedAt");
CREATE INDEX IF NOT EXISTS "CrmWorkflowRun_status_resumeAt_idx" ON "CrmWorkflowRun"("status", "resumeAt");

ALTER TABLE "CrmWorkflowRun" DROP CONSTRAINT IF EXISTS "CrmWorkflowRun_workflowId_fkey";
ALTER TABLE "CrmWorkflowRun" ADD CONSTRAINT "CrmWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "CrmWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
