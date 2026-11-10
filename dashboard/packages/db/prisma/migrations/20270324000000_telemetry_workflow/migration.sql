-- Telemetry's issue workflow: a log of what people did to an issue (comments,
-- status changes, assignments, tasks made from it), and the indexes the issue
-- search sorts and filters with. Additive and idempotent.
-- To reverse: drop the TelemetryActivity table and the indexes created below.

CREATE TABLE IF NOT EXISTS "TelemetryActivity" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "ref" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelemetryActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TelemetryActivity_issueId_at_idx" ON "TelemetryActivity"("issueId", "at");

ALTER TABLE "TelemetryActivity" DROP CONSTRAINT IF EXISTS "TelemetryActivity_issueId_fkey";
ALTER TABLE "TelemetryActivity" ADD CONSTRAINT "TelemetryActivity_issueId_fkey"
    FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_status_firstSeen_idx" ON "TelemetryIssue"("projectId", "status", "firstSeen");
CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_status_timesSeen_idx" ON "TelemetryIssue"("projectId", "status", "timesSeen");
CREATE INDEX IF NOT EXISTS "TelemetryIssue_projectId_assignedToId_lastSeen_idx" ON "TelemetryIssue"("projectId", "assignedToId", "lastSeen");

CREATE INDEX IF NOT EXISTS "TelemetryEvent_issueId_environment_idx" ON "TelemetryEvent"("issueId", "environment");
CREATE INDEX IF NOT EXISTS "TelemetryEvent_issueId_release_idx" ON "TelemetryEvent"("issueId", "release");
CREATE INDEX IF NOT EXISTS "TelemetryEvent_projectId_release_idx" ON "TelemetryEvent"("projectId", "release");
