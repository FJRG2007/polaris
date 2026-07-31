-- Self-hosted GitHub Actions runners.
--
-- A RunnerPool is configuration: keep N ephemeral runners alive on one registered
-- server so workflows selecting its labels have somewhere to land. A RunnerJob is
-- the record of one of those runners - registered just-in-time, given a single
-- job, then gone. There is deliberately no column that would let a runner outlive
-- its job: that is what leaves a credential on the machine's disk.
CREATE TABLE "RunnerPool" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- repo | org. Org-level covers every repository at once and needs a narrower
    -- GitHub App permission than repository-level does.
    "scope" TEXT NOT NULL,
    "targetOwner" TEXT NOT NULL,
    "targetRepo" TEXT,
    -- Labels a workflow selects with `runs-on`, as a stringified JSON array.
    "labels" TEXT NOT NULL,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    -- container | workspace.
    "isolation" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerPool_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunnerPool_ownerId_idx" ON "RunnerPool"("ownerId");
CREATE INDEX "RunnerPool_hostId_idx" ON "RunnerPool"("hostId");

ALTER TABLE "RunnerPool" ADD CONSTRAINT "RunnerPool_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Removing the server removes the pool with it: a pool with nowhere to run is not
-- a pool, and leaving it behind would keep registering runners against a machine
-- Polaris can no longer reach.
ALTER TABLE "RunnerPool" ADD CONSTRAINT "RunnerPool_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One ephemeral runner's life. Kept after it finishes because the runner
-- de-registers itself, so GitHub stops being able to say what ran.
CREATE TABLE "RunnerJob" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "githubRunnerId" INTEGER,
    -- starting | idle | busy | finished | failed.
    "state" TEXT NOT NULL DEFAULT 'starting',
    "isolation" TEXT NOT NULL,
    -- Container name or detached pid. Advisory: liveness is probed on the machine,
    -- never inferred from this column.
    "handle" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RunnerJob_pkey" PRIMARY KEY ("id")
);

-- The reconciler asks "which runners of this pool are still live" on every pass,
-- so the state is part of the index rather than a filter over the pool's history.
CREATE INDEX "RunnerJob_poolId_state_idx" ON "RunnerJob"("poolId", "state");
CREATE INDEX "RunnerJob_startedAt_idx" ON "RunnerJob"("startedAt");

ALTER TABLE "RunnerJob" ADD CONSTRAINT "RunnerJob_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "RunnerPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
