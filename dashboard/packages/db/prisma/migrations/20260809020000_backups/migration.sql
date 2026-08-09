-- Backups as a service, rather than files in a folder.
--
-- Before this, a backup was one of two things with nothing in common: a gzipped
-- dump written into the data dir with no record of it anywhere, and a tar taken
-- inside a game server's container with its schedule stored as JSON inside that
-- app's config column. Neither could be listed, counted, scheduled uniformly, or
-- replicated anywhere. Nothing could answer "what is protected here", because
-- nothing recorded that anything was.
--
-- These seven tables answer it: what is protected, under which policy, where the
-- copies went, and what ran. Nothing is backfilled by this migration - the
-- existing dump files and world archives are adopted by the application on first
-- read, so an instance that never opens the screen loses nothing and an instance
-- that does finds its history already there.

-- Somewhere copies are written: the data dir, beside the source, a storage
-- connection (NAS, S3, a linked drive), or an enrolled machine over SSH.
CREATE TABLE "BackupDestination" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "connectionId" UUID,
    "hostId" UUID,
    "basePath" TEXT NOT NULL DEFAULT 'polaris-backups',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupDestination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackupDestination_ownerId_name_key" ON "BackupDestination"("ownerId", "name");
CREATE INDEX "BackupDestination_ownerId_idx" ON "BackupDestination"("ownerId");
CREATE INDEX "BackupDestination_connectionId_idx" ON "BackupDestination"("connectionId");
CREATE INDEX "BackupDestination_hostId_idx" ON "BackupDestination"("hostId");

-- Schedule and retention together: a schedule with no retention rule is a disk
-- that fills up, which is the outcome backups exist to prevent.
CREATE TABLE "BackupPlan" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "every" TEXT NOT NULL DEFAULT 'off',
    "keepLast" INTEGER NOT NULL DEFAULT 7,
    "keepDays" INTEGER NOT NULL DEFAULT 0,
    "maxBytes" BIGINT NOT NULL DEFAULT 0,
    "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackupPlan_ownerId_name_key" ON "BackupPlan"("ownerId", "name");
CREATE INDEX "BackupPlan_ownerId_idx" ON "BackupPlan"("ownerId");

-- How many copies a plan makes, and where. Position 0 is written first and is
-- what the rest are replicated from, so the source is read once per backup.
CREATE TABLE "BackupPlanDestination" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BackupPlanDestination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackupPlanDestination_planId_destinationId_key"
    ON "BackupPlanDestination"("planId", "destinationId");
CREATE INDEX "BackupPlanDestination_destinationId_idx" ON "BackupPlanDestination"("destinationId");

-- One thing being backed up. The counters are denormalized because this table is
-- read as a list of hundreds of rows sorted by last backup and filtered by
-- status; deriving either from the points would make every page load a scan.
CREATE TABLE "ProtectedResource" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "encryptedCredential" BYTEA,
    "credentialNonce" BYTEA,
    "credentialKeyId" TEXT,
    "planId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastBackupAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "copyCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtectedResource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProtectedResource_ownerId_selector_key" ON "ProtectedResource"("ownerId", "selector");
CREATE INDEX "ProtectedResource_ownerId_kind_idx" ON "ProtectedResource"("ownerId", "kind");
CREATE INDEX "ProtectedResource_ownerId_status_idx" ON "ProtectedResource"("ownerId", "status");
CREATE INDEX "ProtectedResource_ownerId_lastBackupAt_idx" ON "ProtectedResource"("ownerId", "lastBackupAt");
CREATE INDEX "ProtectedResource_nextDueAt_idx" ON "ProtectedResource"("nextDueAt");
CREATE INDEX "ProtectedResource_planId_idx" ON "ProtectedResource"("planId");

-- One backup: a moment of a resource, however many places it ended up. `partial`
-- is a real outcome - the local copy landed, the remote one did not, and what is
-- on disk is still restorable.
CREATE TABLE "RecoveryPoint" (
    "id" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "planId" UUID,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryPoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecoveryPoint_resourceId_takenAt_idx" ON "RecoveryPoint"("resourceId", "takenAt");
CREATE INDEX "RecoveryPoint_status_idx" ON "RecoveryPoint"("status");
CREATE INDEX "RecoveryPoint_expiresAt_idx" ON "RecoveryPoint"("expiresAt");

-- The same backup in one destination. Retention is applied here rather than on
-- the point, because a game server's own disk holds days and a bucket holds a
-- year, and one number for both either fills the disk or discards the archive.
CREATE TABLE "RecoveryPointCopy" (
    "id" UUID NOT NULL,
    "pointId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPointCopy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryPointCopy_pointId_destinationId_key"
    ON "RecoveryPointCopy"("pointId", "destinationId");
CREATE INDEX "RecoveryPointCopy_destinationId_status_idx" ON "RecoveryPointCopy"("destinationId", "status");

-- What ran, including what worked: the question this is opened for is usually
-- "is it still running", which a failures-only log cannot answer.
CREATE TABLE "BackupJob" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "resourceId" UUID,
    "pointId" UUID,
    "type" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'running',
    "actorUserId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "BackupJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupJob_ownerId_startedAt_idx" ON "BackupJob"("ownerId", "startedAt");
CREATE INDEX "BackupJob_resourceId_startedAt_idx" ON "BackupJob"("resourceId", "startedAt");
CREATE INDEX "BackupJob_status_idx" ON "BackupJob"("status");

-- Deleting a connection or a host that still holds copies is refused rather than
-- cascaded: the rows would survive as pointers to bytes nobody can fetch, which
-- reads on screen exactly like a backup that exists.
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BackupPlan" ADD CONSTRAINT "BackupPlan_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BackupPlanDestination" ADD CONSTRAINT "BackupPlanDestination_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "BackupPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupPlanDestination" ADD CONSTRAINT "BackupPlanDestination_destinationId_fkey"
    FOREIGN KEY ("destinationId") REFERENCES "BackupDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Detaching a plan leaves the resource protected and on-demand, which is a state
-- somebody chose; it must not delete what is being protected.
ALTER TABLE "ProtectedResource" ADD CONSTRAINT "ProtectedResource_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectedResource" ADD CONSTRAINT "ProtectedResource_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "BackupPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RecoveryPoint" ADD CONSTRAINT "RecoveryPoint_resourceId_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "ProtectedResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecoveryPointCopy" ADD CONSTRAINT "RecoveryPointCopy_pointId_fkey"
    FOREIGN KEY ("pointId") REFERENCES "RecoveryPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryPointCopy" ADD CONSTRAINT "RecoveryPointCopy_destinationId_fkey"
    FOREIGN KEY ("destinationId") REFERENCES "BackupDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
