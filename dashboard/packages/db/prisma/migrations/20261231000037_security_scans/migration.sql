-- Security scans (apps/security-scans): scans, what they found, quarantined
-- files, file baselines and per-server settings. Additive: new tables only.
-- Every statement is written so that running it a second time is a no-op. To
-- reverse, drop the five tables.

CREATE TABLE IF NOT EXISTS "SecurityScan" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "input" TEXT NOT NULL DEFAULT '{}',
    "state" TEXT NOT NULL DEFAULT 'queued',
    "summary" TEXT NOT NULL DEFAULT '{}',
    "payload" BYTEA,
    "error" TEXT,
    "requestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "SecurityScan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SecurityScan_targetId_kind_createdAt_idx" ON "SecurityScan"("targetId", "kind", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "SecurityScan_state_createdAt_idx" ON "SecurityScan"("state", "createdAt");
-- One scan running per server at a time: the claim that starts one fails on
-- this index while another is running there.
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityScan_one_running_per_target" ON "SecurityScan"("targetId") WHERE "state" = 'running';

CREATE TABLE IF NOT EXISTS "SecurityFinding" (
    "id" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "volumeId" UUID,
    "fixedIn" TEXT,
    "url" TEXT,
    "position" INTEGER NOT NULL,
    CONSTRAINT "SecurityFinding_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SecurityFinding_scanId_position_idx" ON "SecurityFinding"("scanId", "position");

CREATE TABLE IF NOT EXISTS "SecurityQuarantine" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "volume" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "SecurityQuarantine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SecurityQuarantine_targetId_state_createdAt_idx" ON "SecurityQuarantine"("targetId", "state", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS "SecurityBaseline" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "subpath" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL,
    "manifest" BYTEA NOT NULL,
    "files" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityBaseline_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityBaseline_targetId_volumeId_subpath_key" ON "SecurityBaseline"("targetId", "volumeId", "subpath");

CREATE TABLE IF NOT EXISTS "SecuritySetting" (
    "targetId" UUID NOT NULL,
    "everyHours" INTEGER NOT NULL DEFAULT 0,
    "lastPlanned" TIMESTAMP(3),
    "updates" TEXT NOT NULL DEFAULT 'unknown',
    "updatesAt" TIMESTAMP(3),
    "distro" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SecuritySetting_pkey" PRIMARY KEY ("targetId")
);
CREATE INDEX IF NOT EXISTS "SecuritySetting_everyHours_idx" ON "SecuritySetting"("everyHours");

ALTER TABLE "SecurityScan" DROP CONSTRAINT IF EXISTS "SecurityScan_targetId_fkey";
ALTER TABLE "SecurityScan" ADD CONSTRAINT "SecurityScan_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityFinding" DROP CONSTRAINT IF EXISTS "SecurityFinding_scanId_fkey";
ALTER TABLE "SecurityFinding" ADD CONSTRAINT "SecurityFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SecurityScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityQuarantine" DROP CONSTRAINT IF EXISTS "SecurityQuarantine_targetId_fkey";
ALTER TABLE "SecurityQuarantine" ADD CONSTRAINT "SecurityQuarantine_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityBaseline" DROP CONSTRAINT IF EXISTS "SecurityBaseline_targetId_fkey";
ALTER TABLE "SecurityBaseline" ADD CONSTRAINT "SecurityBaseline_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecuritySetting" DROP CONSTRAINT IF EXISTS "SecuritySetting_targetId_fkey";
ALTER TABLE "SecuritySetting" ADD CONSTRAINT "SecuritySetting_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
