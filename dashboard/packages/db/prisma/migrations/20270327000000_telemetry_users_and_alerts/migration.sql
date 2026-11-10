-- Telemetry: how many people an issue affected, and alert rules per project
-- with a history of when they fired. Additive and idempotent.
-- To reverse: drop TelemetryAlertFire, TelemetryAlertRule and TelemetryIssueUser,
-- and the userCount column of TelemetryIssue with the index made on it.

ALTER TABLE "TelemetryIssue" ADD COLUMN IF NOT EXISTS "userCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_status_userCount_idx" ON "TelemetryIssue"("projectId", "status", "userCount");

CREATE TABLE IF NOT EXISTS "TelemetryIssueUser" (
    "issueId" UUID NOT NULL,
    "userHash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelemetryIssueUser_pkey" PRIMARY KEY ("issueId", "userHash")
);

ALTER TABLE "TelemetryIssueUser" DROP CONSTRAINT IF EXISTS "TelemetryIssueUser_issueId_fkey";
ALTER TABLE "TelemetryIssueUser" ADD CONSTRAINT "TelemetryIssueUser_issueId_fkey"
    FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the events still kept. Before this, an event's user context was
-- stored only as its label (username, else email, else id) and the address in
-- its detail, so those are what the backfill counts people by. An issue whose
-- events were all pruned starts at 0 and counts from its next event.
INSERT INTO "TelemetryIssueUser" ("issueId", "userHash", "at")
SELECT k."issueId", encode(sha256(convert_to(k."key", 'UTF8')), 'hex'), MIN(k."at")
FROM (
    SELECT e."issueId",
           e."at",
           CASE
               WHEN e."userLabel" IS NOT NULL AND e."userLabel" <> '' THEN 'label:' || e."userLabel"
               WHEN e."detail" LIKE '{%' THEN 'ip:' || COALESCE(e."detail"::jsonb ->> 'ip', '')
               ELSE 'ip:'
           END AS "key"
    FROM "TelemetryEvent" e
) k
WHERE k."key" <> 'ip:'
GROUP BY k."issueId", k."key"
ON CONFLICT ("issueId", "userHash") DO NOTHING;

UPDATE "TelemetryIssue" i
SET "userCount" = c."n"
FROM (SELECT "issueId", COUNT(*)::INTEGER AS "n" FROM "TelemetryIssueUser" GROUP BY "issueId") c
WHERE c."issueId" = i."id" AND i."userCount" <> c."n";

CREATE TABLE IF NOT EXISTS "TelemetryAlertRule" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 0,
    "windowMinutes" INTEGER NOT NULL DEFAULT 0,
    "levels" TEXT NOT NULL DEFAULT '[]',
    "environment" TEXT,
    "recipients" TEXT NOT NULL DEFAULT '[]',
    "notifyMembers" BOOLEAN NOT NULL DEFAULT true,
    "throttleMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdById" UUID,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelemetryAlertRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TelemetryAlertRule_projectId_createdAt_idx" ON "TelemetryAlertRule"("projectId", "createdAt");

ALTER TABLE "TelemetryAlertRule" DROP CONSTRAINT IF EXISTS "TelemetryAlertRule_projectId_fkey";
ALTER TABLE "TelemetryAlertRule" ADD CONSTRAINT "TelemetryAlertRule_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TelemetryAlertFire" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelemetryAlertFire_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TelemetryAlertFire_ruleId_issueId_at_idx" ON "TelemetryAlertFire"("ruleId", "issueId", "at");
CREATE INDEX IF NOT EXISTS "TelemetryAlertFire_projectId_at_idx" ON "TelemetryAlertFire"("projectId", "at");

ALTER TABLE "TelemetryAlertFire" DROP CONSTRAINT IF EXISTS "TelemetryAlertFire_projectId_fkey";
ALTER TABLE "TelemetryAlertFire" ADD CONSTRAINT "TelemetryAlertFire_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelemetryAlertFire" DROP CONSTRAINT IF EXISTS "TelemetryAlertFire_ruleId_fkey";
ALTER TABLE "TelemetryAlertFire" ADD CONSTRAINT "TelemetryAlertFire_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "TelemetryAlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelemetryAlertFire" DROP CONSTRAINT IF EXISTS "TelemetryAlertFire_issueId_fkey";
ALTER TABLE "TelemetryAlertFire" ADD CONSTRAINT "TelemetryAlertFire_issueId_fkey"
    FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
