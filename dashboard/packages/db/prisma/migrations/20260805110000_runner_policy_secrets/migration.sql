-- Runner secrets, per-repository policy, and what a runner actually ran.
--
-- Three things a self-hosted CI system could not answer before this, all of them
-- versions of the same question: who is allowed to make one of the operator's
-- machines do something, and with what in reach while it does it.
--
-- RunnerRepoConfig is the operator's decision, per repository. It is a table of
-- its own rather than columns on RunnerPoolTarget because that table is derived
-- and gets deleted and rebuilt whenever a scope re-resolves - a GitHub outage
-- that briefly resolves a scope smaller would otherwise wipe "this public
-- repository was reviewed and allowed" and silently restore the default. A
-- missing row means the cautious defaults, never the permissive ones.
--
-- RunnerSecret is what the machine carries into the job. It is scoped to the
-- registration rather than to anything looser, because a runner is registered
-- against exactly one repository: a secret scoped to that repository reaches its
-- jobs and cannot reach anybody else's. Values are envelope-encrypted with the
-- master key like every other credential Polaris holds.
--
-- The RunnerPoolTarget columns are derived: what GitHub says the repository is
-- right now. Visibility is the one that decides whether Polaris will serve it at
-- all, and it is re-read rather than remembered - a repository can be made public
-- long after somebody pointed a machine at it.
--
-- The RunnerJob columns are what the job turned out to be. They are recorded on
-- the machine by the guard hook and read back when the runner is reaped, because
-- they cannot be asked for afterwards: an ephemeral runner de-registers itself as
-- its job ends and GitHub stops being able to say which job it took.

-- CreateTable
CREATE TABLE "RunnerRepoConfig" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "allowForks" BOOLEAN NOT NULL DEFAULT false,
    "allowPublic" BOOLEAN NOT NULL DEFAULT false,
    "secrets" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerRepoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunnerRepoConfig_poolId_key_key" ON "RunnerRepoConfig"("poolId", "key");

-- CreateIndex
CREATE INDEX "RunnerRepoConfig_poolId_idx" ON "RunnerRepoConfig"("poolId");

-- AddForeignKey
ALTER TABLE "RunnerRepoConfig" ADD CONSTRAINT "RunnerRepoConfig_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "RunnerSecret" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "encryptedValue" BYTEA NOT NULL,
    "valueNonce" BYTEA NOT NULL,
    "valueKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunnerSecret_poolId_scopeKey_key_key" ON "RunnerSecret"("poolId", "scopeKey", "key");

-- CreateIndex
CREATE INDEX "RunnerSecret_poolId_idx" ON "RunnerSecret"("poolId");

-- AddForeignKey
ALTER TABLE "RunnerSecret" ADD CONSTRAINT "RunnerSecret_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "RunnerPoolTarget" ADD COLUMN "visibility" TEXT;
ALTER TABLE "RunnerPoolTarget" ADD COLUMN "forkApproval" TEXT;
ALTER TABLE "RunnerPoolTarget" ADD COLUMN "checkedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RunnerJob" ADD COLUMN "workflow" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "jobName" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "runId" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "event" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "actor" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "ref" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "sha" TEXT;
ALTER TABLE "RunnerJob" ADD COLUMN "refusedReason" TEXT;
