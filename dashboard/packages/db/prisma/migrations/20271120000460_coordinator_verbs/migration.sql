-- Coordinator verbs (U16a): per-role agent defaults on a repository, and a
-- spawned worker's role, model and idempotency key on its orchestration task.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "roleAgents" TEXT;
ALTER TABLE "AgentOrchestrationTask" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE "AgentOrchestrationTask" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "AgentOrchestrationTask" ADD COLUMN IF NOT EXISTS "clientKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "AgentOrchestrationTask_runId_clientKey_key" ON "AgentOrchestrationTask"("runId", "clientKey");
