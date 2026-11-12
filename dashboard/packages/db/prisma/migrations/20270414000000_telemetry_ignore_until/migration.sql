-- Telemetry: ignoring an issue for a while or for a number of events, as
-- Sentry's "ignore until". Additive and idempotent.
-- To reverse: drop the ignoredUntil and ignoreUntilSeen columns of TelemetryIssue.

ALTER TABLE "TelemetryIssue" ADD COLUMN IF NOT EXISTS "ignoredUntil" TIMESTAMP(3);
ALTER TABLE "TelemetryIssue" ADD COLUMN IF NOT EXISTS "ignoreUntilSeen" INTEGER;
