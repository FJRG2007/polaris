-- What GitHub last said about each pull request opened from a Code session's
-- branch, for the session's derived status (lib/agents/session-pr-facts.ts).
CREATE TABLE IF NOT EXISTS "SessionPullFacts" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "mergeable" TEXT NOT NULL DEFAULT 'unknown',
    "checks" TEXT NOT NULL DEFAULT 'unknown',
    "checksTotal" INTEGER NOT NULL DEFAULT 0,
    "checksFailed" INTEGER NOT NULL DEFAULT 0,
    "checksPending" INTEGER NOT NULL DEFAULT 0,
    "review" TEXT NOT NULL DEFAULT 'none',
    "unresolvedComments" INTEGER NOT NULL DEFAULT 0,
    "headSha" TEXT NOT NULL DEFAULT '',
    "sourceBranch" TEXT NOT NULL DEFAULT '',
    "targetBranch" TEXT NOT NULL DEFAULT '',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionPullFacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SessionPullFacts_sessionId_number_key" ON "SessionPullFacts"("sessionId", "number");
CREATE INDEX IF NOT EXISTS "SessionPullFacts_repoFullName_number_idx" ON "SessionPullFacts"("repoFullName", "number");
CREATE INDEX IF NOT EXISTS "SessionPullFacts_state_fetchedAt_idx" ON "SessionPullFacts"("state", "fetchedAt");

ALTER TABLE "SessionPullFacts" DROP CONSTRAINT IF EXISTS "SessionPullFacts_sessionId_fkey";
ALTER TABLE "SessionPullFacts" ADD CONSTRAINT "SessionPullFacts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- How a pull request webhook finds its sessions: by the recorded number, or by
-- the branch the pull request was opened from.
CREATE INDEX IF NOT EXISTS "AgentSession_repoId_prNumber_idx" ON "AgentSession"("repoId", "prNumber");
CREATE INDEX IF NOT EXISTS "AgentSession_repoId_branch_idx" ON "AgentSession"("repoId", "branch");
