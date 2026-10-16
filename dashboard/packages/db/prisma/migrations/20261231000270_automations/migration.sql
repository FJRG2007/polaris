-- Central automations: the store, the outbox, runs and steps, secrets and
-- folders, and the automations permissions on the seeded roles.
--
-- Every statement is written so that running it a second time is a no-op, and
-- nothing existing is changed but the two seeded roles below.
--
-- Reversal (nothing else references these tables):
--   DROP TABLE IF EXISTS "AutomationStep", "AutomationRun", "AutomationTrigger",
--     "AutomationVersion", "AutomationEvent", "AutomationSecret",
--     "AutomationFolder", "Automation";
--   and remove "automations.use" / "automations.secrets" from the seeded roles.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Automation" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "folderId" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "draft" JSONB NOT NULL,
    "draftUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedVersionId" UUID,
    "runAsId" UUID,
    "mode" TEXT NOT NULL DEFAULT 'single',
    "maxRuns" INTEGER NOT NULL DEFAULT 10,
    "rateLimit" INTEGER NOT NULL DEFAULT 20,
    "origin" TEXT,
    "originRef" TEXT,
    "legacyRef" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationVersion" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "name" TEXT,
    "savedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationTrigger" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectKey" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "state" JSONB,
    "hookHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationEvent" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "subjectKey" TEXT,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "originRunId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedUntil" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationRun" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "triggerNodeId" TEXT NOT NULL,
    "cause" JSONB NOT NULL,
    "firingKey" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "parentRunId" UUID,
    "parentStepId" UUID,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "finally" TEXT NOT NULL DEFAULT 'none',
    "outcome" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lockToken" TEXT,
    "dueAt" TIMESTAMP(3),
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationStep" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "iteration" TEXT NOT NULL DEFAULT '0',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "port" TEXT,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "waitUntil" TIMESTAMP(3),
    "waitKey" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationSecret" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "encrypted" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "keyId" TEXT,
    "createdById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomationFolder" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Automation_legacyRef_key" ON "Automation"("legacyRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Automation_orgId_updatedAt_idx" ON "Automation"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Automation_userId_updatedAt_idx" ON "Automation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Automation_origin_originRef_idx" ON "Automation"("origin", "originRef");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationVersion_automationId_number_key" ON "AutomationVersion"("automationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationTrigger_hookHash_key" ON "AutomationTrigger"("hookHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationTrigger_eventType_subjectKey_idx" ON "AutomationTrigger"("eventType", "subjectKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationTrigger_nextDueAt_idx" ON "AutomationTrigger"("nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationTrigger_automationId_nodeId_key" ON "AutomationTrigger"("automationId", "nodeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationEvent_processedAt_createdAt_idx" ON "AutomationEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationEvent_type_dedupeKey_key" ON "AutomationEvent"("type", "dedupeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationRun_automationId_queuedAt_idx" ON "AutomationRun"("automationId", "queuedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationRun_status_dueAt_idx" ON "AutomationRun"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationRun_parentRunId_idx" ON "AutomationRun"("parentRunId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationRun_automationId_firingKey_key" ON "AutomationRun"("automationId", "firingKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationStep_runId_status_idx" ON "AutomationStep"("runId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationStep_status_waitUntil_idx" ON "AutomationStep"("status", "waitUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationStep_waitKey_idx" ON "AutomationStep"("waitKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationStep_runId_nodeId_iteration_attempt_key" ON "AutomationStep"("runId", "nodeId", "iteration", "attempt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationSecret_orgId_idx" ON "AutomationSecret"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationSecret_userId_idx" ON "AutomationSecret"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationFolder_orgId_idx" ON "AutomationFolder"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AutomationFolder_userId_idx" ON "AutomationFolder"("userId");

-- AddForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT IF EXISTS "Automation_orgId_fkey";
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT IF EXISTS "Automation_userId_fkey";
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" DROP CONSTRAINT IF EXISTS "AutomationVersion_automationId_fkey";
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationTrigger" DROP CONSTRAINT IF EXISTS "AutomationTrigger_automationId_fkey";
ALTER TABLE "AutomationTrigger" ADD CONSTRAINT "AutomationTrigger_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" DROP CONSTRAINT IF EXISTS "AutomationRun_automationId_fkey";
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationStep" DROP CONSTRAINT IF EXISTS "AutomationStep_runId_fkey";
ALTER TABLE "AutomationStep" ADD CONSTRAINT "AutomationStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationSecret" DROP CONSTRAINT IF EXISTS "AutomationSecret_orgId_fkey";
ALTER TABLE "AutomationSecret" ADD CONSTRAINT "AutomationSecret_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationSecret" DROP CONSTRAINT IF EXISTS "AutomationSecret_userId_fkey";
ALTER TABLE "AutomationSecret" ADD CONSTRAINT "AutomationSecret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFolder" DROP CONSTRAINT IF EXISTS "AutomationFolder_orgId_fkey";
ALTER TABLE "AutomationFolder" ADD CONSTRAINT "AutomationFolder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFolder" DROP CONSTRAINT IF EXISTS "AutomationFolder_userId_fkey";
ALTER TABLE "AutomationFolder" ADD CONSTRAINT "AutomationFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Give the seeded member and viewer roles `automations.use`, and the member role
-- `automations.secrets`, the way they hold `crm.use`: a personal automation is the
-- account's own. Only where it is missing, so a role an operator narrowed on
-- purpose keeps everything else it says.
UPDATE "Role"
SET "permissions" = (("permissions"::jsonb) || '["automations.use"]'::jsonb)::text
WHERE "isSystem" = true
  AND "name" IN ('member', 'viewer')
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["automations.use"]'::jsonb);

UPDATE "Role"
SET "permissions" = (("permissions"::jsonb) || '["automations.secrets"]'::jsonb)::text
WHERE "isSystem" = true
  AND "name" = 'member'
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["automations.secrets"]'::jsonb);
