-- Runner pools that serve more than one repository, within a budget.
--
-- A pool used to be one registration: an owner, maybe a repository, and a count of
-- runners to keep waiting there. It is now a rule ("these repositories", "this
-- account", "these people") that resolves to a set of registrations, plus what any
-- one of them is allowed to spend. Three things follow from that:
--
--   - the target moves out of RunnerPool and into RunnerPoolTarget, one row per
--     place runners are registered, carrying the per-target state a pass needs;
--   - RunnerJob records which target it ran for, so a repository's consumption can
--     still be counted after the pool stopped serving it;
--   - a Polaris account can carry a GitHub identity, which is the only way "these
--     people's repositories" can mean anything that was not typed in by hand.
--
-- Existing pools are single-repository or single-organization by definition, so
-- they convert exactly: their scope keeps its name and their target becomes the
-- pool's one row.

-- --------------------------------------------------------------------------
-- Pools: the scope becomes a rule, and gains its limits.
-- --------------------------------------------------------------------------

ALTER TABLE "RunnerPool" ADD COLUMN "scopeConfig" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "RunnerPool" ADD COLUMN "perTargetConcurrent" INTEGER;
ALTER TABLE "RunnerPool" ADD COLUMN "minutesBudget" INTEGER;
ALTER TABLE "RunnerPool" ADD COLUMN "minutesWindow" TEXT NOT NULL DEFAULT 'month';
ALTER TABLE "RunnerPool" ADD COLUMN "jobsPerDay" INTEGER;
ALTER TABLE "RunnerPool" ADD COLUMN "onExhausted" TEXT NOT NULL DEFAULT 'pause';
ALTER TABLE "RunnerPool" ADD COLUMN "targetsResolvedAt" TIMESTAMP(3);

-- The old two columns are the whole of the old scope, so they become the new one.
UPDATE "RunnerPool"
SET "scopeConfig" = CASE
    WHEN "scope" = 'org' THEN json_build_object('kind', 'org', 'owner', "targetOwner")::text
    ELSE json_build_object('kind', 'repo', 'owner', "targetOwner", 'repo', COALESCE("targetRepo", ''))::text
END;

-- --------------------------------------------------------------------------
-- Targets: where a pool actually registers runners.
-- --------------------------------------------------------------------------

CREATE TABLE "RunnerPoolTarget" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    -- "owner/repo", or "owner" for an organization registration.
    "key" TEXT NOT NULL,
    -- repo | org.
    "kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT,
    -- Jobs GitHub has waiting for this target, as last observed.
    "queued" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3),
    -- When this pool last started a runner here; oldest first gets served.
    "lastServedAt" TIMESTAMP(3),
    -- Why it is not being served (a spent budget), or null.
    "blocked" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerPoolTarget_pkey" PRIMARY KEY ("id")
);

-- The key, not (owner, repo): an organization target has no repository, and in
-- Postgres two NULLs are distinct, so a unique index over the pair would happily
-- hold the same organization twice.
CREATE UNIQUE INDEX "RunnerPoolTarget_poolId_key_key" ON "RunnerPoolTarget"("poolId", "key");
CREATE INDEX "RunnerPoolTarget_poolId_idx" ON "RunnerPoolTarget"("poolId");

ALTER TABLE "RunnerPoolTarget" ADD CONSTRAINT "RunnerPoolTarget_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every pool that exists today serves exactly one target: itself.
INSERT INTO "RunnerPoolTarget" ("id", "poolId", "key", "kind", "owner", "repo", "createdAt", "updatedAt")
SELECT
    gen_random_uuid(),
    "id",
    CASE WHEN "scope" = 'org' THEN "targetOwner" ELSE "targetOwner" || '/' || COALESCE("targetRepo", '') END,
    CASE WHEN "scope" = 'org' THEN 'org' ELSE 'repo' END,
    "targetOwner",
    CASE WHEN "scope" = 'org' THEN NULL ELSE "targetRepo" END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "RunnerPool";

-- --------------------------------------------------------------------------
-- Jobs: which target this one ran for, and when it started actually working.
-- --------------------------------------------------------------------------

ALTER TABLE "RunnerJob" ADD COLUMN "targetOwner" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RunnerJob" ADD COLUMN "targetRepo" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "busyAt" TIMESTAMP(3);

UPDATE "RunnerJob" AS j
SET "targetOwner" = p."targetOwner",
    "targetRepo" = CASE WHEN p."scope" = 'org' THEN NULL ELSE p."targetRepo" END
FROM "RunnerPool" AS p
WHERE j."poolId" = p."id";

CREATE INDEX "RunnerJob_poolId_targetOwner_startedAt_idx"
    ON "RunnerJob"("poolId", "targetOwner", "startedAt");

-- The target has moved to its own table; leaving these behind would give a pool
-- two answers to "what does it serve", one of which would stop being updated.
ALTER TABLE "RunnerPool" DROP COLUMN "targetOwner";
ALTER TABLE "RunnerPool" DROP COLUMN "targetRepo";

-- --------------------------------------------------------------------------
-- A Polaris account's GitHub identity.
-- --------------------------------------------------------------------------

CREATE TABLE "GithubIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    -- GitHub's numeric id. The identity that survives a rename; the login is a
    -- label that a different person can end up holding.
    "githubId" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GithubIdentity_userId_key" ON "GithubIdentity"("userId");
-- One GitHub account, one Polaris account. Without this, two people could both
-- claim the same login and a pool serving "these people" would serve it twice.
CREATE UNIQUE INDEX "GithubIdentity_githubId_key" ON "GithubIdentity"("githubId");

ALTER TABLE "GithubIdentity" ADD CONSTRAINT "GithubIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
