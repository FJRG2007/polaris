-- Which pull requests the repository bot reviews on its own, per tier.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "review" TEXT;
ALTER TABLE "AgentDefaults" ADD COLUMN IF NOT EXISTS "review" TEXT;
CREATE INDEX IF NOT EXISTS "AgentRun_repoId_prNumber_idx" ON "AgentRun"("repoId", "prNumber");
