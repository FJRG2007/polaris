-- CreateTable
CREATE TABLE IF NOT EXISTS "TelemetryProject" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "deployProjectId" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "platform" TEXT,
    "publicKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetryProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelemetryIssue" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "culprit" TEXT NOT NULL DEFAULT '',
    "level" TEXT NOT NULL DEFAULT 'error',
    "status" TEXT NOT NULL DEFAULT 'unresolved',
    "timesSeen" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRelease" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolvedInRelease" TEXT,
    "assignedToId" UUID,

    CONSTRAINT "TelemetryIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelemetryEvent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "eventId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'error',
    "message" TEXT NOT NULL,
    "culprit" TEXT NOT NULL DEFAULT '',
    "release" TEXT,
    "environment" TEXT,
    "serverName" TEXT,
    "transaction" TEXT,
    "url" TEXT,
    "method" TEXT,
    "userLabel" TEXT,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelemetryDay" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TelemetryDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryProject_number_key" ON "TelemetryProject"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryProject_publicKey_key" ON "TelemetryProject"("publicKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryProject_orgId_idx" ON "TelemetryProject"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryProject_deployProjectId_idx" ON "TelemetryProject"("deployProjectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryProject_ownerId_slug_key" ON "TelemetryProject"("ownerId", "slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_status_lastSeen_idx" ON "TelemetryIssue"("projectId", "status", "lastSeen");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_lastSeen_idx" ON "TelemetryIssue"("projectId", "lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryIssue_projectId_fingerprint_key" ON "TelemetryIssue"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryEvent_issueId_at_idx" ON "TelemetryEvent"("issueId", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryEvent_projectId_at_idx" ON "TelemetryEvent"("projectId", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetryDay_projectId_day_idx" ON "TelemetryDay"("projectId", "day");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryDay_issueId_day_key" ON "TelemetryDay"("issueId", "day");

-- AddForeignKey
ALTER TABLE "TelemetryProject" DROP CONSTRAINT IF EXISTS "TelemetryProject_ownerId_fkey";
ALTER TABLE "TelemetryProject" ADD CONSTRAINT "TelemetryProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryProject" DROP CONSTRAINT IF EXISTS "TelemetryProject_orgId_fkey";
ALTER TABLE "TelemetryProject" ADD CONSTRAINT "TelemetryProject_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryProject" DROP CONSTRAINT IF EXISTS "TelemetryProject_deployProjectId_fkey";
ALTER TABLE "TelemetryProject" ADD CONSTRAINT "TelemetryProject_deployProjectId_fkey" FOREIGN KEY ("deployProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryIssue" DROP CONSTRAINT IF EXISTS "TelemetryIssue_projectId_fkey";
ALTER TABLE "TelemetryIssue" ADD CONSTRAINT "TelemetryIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryIssue" DROP CONSTRAINT IF EXISTS "TelemetryIssue_resolvedById_fkey";
ALTER TABLE "TelemetryIssue" ADD CONSTRAINT "TelemetryIssue_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryIssue" DROP CONSTRAINT IF EXISTS "TelemetryIssue_assignedToId_fkey";
ALTER TABLE "TelemetryIssue" ADD CONSTRAINT "TelemetryIssue_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" DROP CONSTRAINT IF EXISTS "TelemetryEvent_projectId_fkey";
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" DROP CONSTRAINT IF EXISTS "TelemetryEvent_issueId_fkey";
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryDay" DROP CONSTRAINT IF EXISTS "TelemetryDay_projectId_fkey";
ALTER TABLE "TelemetryDay" ADD CONSTRAINT "TelemetryDay_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryDay" DROP CONSTRAINT IF EXISTS "TelemetryDay_issueId_fkey";
ALTER TABLE "TelemetryDay" ADD CONSTRAINT "TelemetryDay_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

