-- Custom agents: permissions, mode, and instance-wide agents (OC13, OC14).
ALTER TABLE "PolarAgent" ADD COLUMN IF NOT EXISTS "permission" JSONB;
ALTER TABLE "PolarAgent" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "PolarAgent" ADD COLUMN IF NOT EXISTS "shared" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "PolarAgent_shared_idx" ON "PolarAgent"("shared");
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "agentPermission" JSONB;
