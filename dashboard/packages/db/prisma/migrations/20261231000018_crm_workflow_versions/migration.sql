-- A CRM workflow's saved versions: what it was named, what set it off and
-- what it did, each time somebody saved it. Additive; every workflow saved
-- before gets its current form as its first version. To reverse, drop the
-- table.

CREATE TABLE IF NOT EXISTS "CrmWorkflowVersion" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actions" TEXT NOT NULL DEFAULT '[]',
    "savedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWorkflowVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmWorkflowVersion_workflowId_createdAt_idx" ON "CrmWorkflowVersion"("workflowId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "CrmWorkflowVersion" ADD CONSTRAINT "CrmWorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "CrmWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "CrmWorkflowVersion" ("id", "workflowId", "name", "trigger", "actions", "savedById", "createdAt")
SELECT gen_random_uuid(), w."id", w."name", w."trigger", w."actions", w."runAsId", w."updatedAt"
FROM "CrmWorkflow" w
WHERE NOT EXISTS (SELECT 1 FROM "CrmWorkflowVersion" v WHERE v."workflowId" = w."id");
