-- What repositories inherit, decided above them.
--
-- Two tiers live in one table and are told apart by `scope`: the empty string is
-- the instance-wide row, a GitHub login is that account's row. Everything is
-- nullable because null means "inherit" - a tier that stored its inherited value
-- would freeze it the moment the tier above changed, which is the whole reason
-- the tiers exist.

CREATE TABLE "AgentDefaults" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    -- "" for the instance-wide row, a GitHub account or organization login
    -- otherwise.
    "scope" TEXT NOT NULL DEFAULT '',
    -- actions | runners | server, and the pool that goes with `runners`.
    "execution" TEXT,
    "poolId" UUID,
    "model" TEXT,
    -- low | medium | high | xhigh | max.
    "effort" TEXT,
    -- disabled | restricted | enabled, for git and for the shell.
    "push" TEXT,
    "shell" TEXT,
    -- Whether the agent may run on a repository of that visibility at all.
    "publicRepos" BOOLEAN,
    "privateRepos" BOOLEAN,
    -- Whether pull-request and issue events start runs. A direct mention is
    -- covered by neither: that is somebody addressing the app.
    "pullRequests" BOOLEAN,
    "issues" BOOLEAN,
    -- off | checks | full.
    "gate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefaults_pkey" PRIMARY KEY ("id")
);

-- One row per scope per owner: saving the same tier twice is the same decision.
CREATE UNIQUE INDEX "AgentDefaults_ownerId_scope_key" ON "AgentDefaults"("ownerId", "scope");
CREATE INDEX "AgentDefaults_ownerId_idx" ON "AgentDefaults"("ownerId");
CREATE INDEX "AgentDefaults_poolId_idx" ON "AgentDefaults"("poolId");

ALTER TABLE "AgentDefaults" ADD CONSTRAINT "AgentDefaults_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same reasoning as AgentRepo: deleting the pool leaves a fixable state that
-- says so on the screen rather than silently turning the agent off.
ALTER TABLE "AgentDefaults" ADD CONSTRAINT "AgentDefaults_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The same three settings, overridable on one repository. Null inherits.
ALTER TABLE "AgentRepo" ADD COLUMN "pullRequests" BOOLEAN;
ALTER TABLE "AgentRepo" ADD COLUMN "issues" BOOLEAN;
ALTER TABLE "AgentRepo" ADD COLUMN "gate" TEXT;
