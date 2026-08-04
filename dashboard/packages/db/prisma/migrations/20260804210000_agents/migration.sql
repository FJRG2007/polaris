-- Coding agents running against enabled repositories.
--
-- Three tables and one rule between them: AgentRepo is configuration an operator
-- set, AgentAutomation is the rules they wrote on it, and AgentRun is what
-- actually happened. Nothing here is recomputed from the GitHub App's
-- installation list, which is what stops a transient API failure from quietly
-- disabling a repository or resetting the decisions on it.

CREATE TABLE "AgentRepo" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    -- "owner/repo". The key every GitHub path, webhook payload and run agrees on.
    "repoFullName" TEXT NOT NULL,
    -- The App installation this repository is reached through, held rather than
    -- looked up per dispatch: the lookup spends a rate-limited call on a value
    -- that only changes when somebody reinstalls the App.
    "installationId" TEXT NOT NULL,
    -- As last observed. Drives the execution recommendation and the default shell
    -- policy, so a repository that goes public is re-read rather than assumed.
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    -- actions | runners | server.
    "execution" TEXT NOT NULL,
    -- The pool `runners` execution uses. Null for the other two.
    "poolId" UUID,
    "model" TEXT NOT NULL,
    -- low | medium | high | xhigh | max. Stored by name so a model changing its
    -- published range does not silently change what was asked for.
    "effort" TEXT NOT NULL DEFAULT 'medium',
    -- disabled | restricted | enabled.
    "push" TEXT NOT NULL DEFAULT 'restricted',
    -- disabled | restricted | enabled.
    "shell" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    -- Null for `server` execution, which needs no workflow file at all.
    "workflowInstalledAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRepo_pkey" PRIMARY KEY ("id")
);

-- One row per repository per owner: enabling a repository twice is the same
-- decision, not two.
CREATE UNIQUE INDEX "AgentRepo_ownerId_repoFullName_key" ON "AgentRepo"("ownerId", "repoFullName");
-- The webhook arrives knowing only the repository, so that is the lookup it does.
CREATE INDEX "AgentRepo_repoFullName_idx" ON "AgentRepo"("repoFullName");
CREATE INDEX "AgentRepo_ownerId_idx" ON "AgentRepo"("ownerId");
CREATE INDEX "AgentRepo_poolId_idx" ON "AgentRepo"("poolId");

ALTER TABLE "AgentRepo" ADD CONSTRAINT "AgentRepo_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting the pool does not delete the repository: the operator's decision to run
-- an agent here outlives the machine they picked for it, and a repository left
-- pointing at nothing is a fixable state that says so on the screen. Cascading
-- would instead silently turn the agent off.
ALTER TABLE "AgentRepo" ADD CONSTRAINT "AgentRepo_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- When to start a run, and what to tell it.
--
-- A repository with no rows here still answers a direct mention. That is the
-- baseline of having the App installed rather than an automation, which is why it
-- is not a row somebody could delete.
CREATE TABLE "AgentAutomation" (
    "id" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    -- Polaris's own trigger names, not GitHub event names: one trigger can span
    -- several events and the mapping belongs in the webhook.
    "trigger" TEXT NOT NULL,
    -- Stringified JSON narrowing the trigger: labels, branches, authors. An empty
    -- or malformed value does not narrow, matching what an empty form means.
    "condition" TEXT NOT NULL DEFAULT '{}',
    -- The runtime mode to force, or null to let the agent choose.
    "mode" TEXT,
    -- Operator prose folded into the run's prompt. Never joined with text from an
    -- issue or a comment, which is a different trust level entirely.
    "instructions" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAutomation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentAutomation_repoId_idx" ON "AgentAutomation"("repoId");

ALTER TABLE "AgentAutomation" ADD CONSTRAINT "AgentAutomation_repoId_fkey"
    FOREIGN KEY ("repoId") REFERENCES "AgentRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One run, written before it is dispatched rather than when it reports in.
--
-- A dispatch that fails, a workflow that never starts and a container that dies on
-- boot are all things somebody has to be able to see, and none of them would write
-- their own row.
CREATE TABLE "AgentRun" (
    "id" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    -- Copied from the repository at dispatch rather than read back later: the
    -- setting can change while a run is in flight, and the run happened where it
    -- happened.
    "execution" TEXT NOT NULL,
    -- queued | running | succeeded | failed | cancelled.
    "state" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT,
    "model" TEXT NOT NULL,
    "issueNumber" INTEGER,
    "prNumber" INTEGER,
    -- GitHub's workflow run id, for the two executions GitHub schedules.
    "githubRunId" TEXT,
    -- The container a `server` run happens in, so its log can be streamed and the
    -- run can be cancelled.
    "containerId" TEXT,
    -- SHA-256 of the token this run authenticates its callbacks with. The raw
    -- value is handed to the runtime once and never stored, so a database dump
    -- cannot be replayed as a live run credential.
    "tokenHash" TEXT,
    -- Who asked, for a manual run. Null when a webhook did. No foreign key: a run
    -- is a record of what happened, and deleting the account must not erase it.
    "startedById" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "error" TEXT,
    -- The structured result a run was asked to produce, as stringified JSON.
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- The run list is per repository, newest first, which is one index rather than two.
CREATE INDEX "AgentRun_repoId_createdAt_idx" ON "AgentRun"("repoId", "createdAt");
-- Every authenticated runtime callback resolves itself through this hash.
CREATE UNIQUE INDEX "AgentRun_tokenHash_key" ON "AgentRun"("tokenHash");
-- The sweep that closes out runs nothing reported back on reads by state.
CREATE INDEX "AgentRun_state_idx" ON "AgentRun"("state");
-- A workflow_run webhook arrives knowing only GitHub's id.
CREATE INDEX "AgentRun_githubRunId_idx" ON "AgentRun"("githubRunId");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_repoId_fkey"
    FOREIGN KEY ("repoId") REFERENCES "AgentRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
