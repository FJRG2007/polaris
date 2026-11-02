-- Waiting scans are found by verdict, oldest attempt first.
CREATE INDEX IF NOT EXISTS "FileScan_verdict_updatedAt_idx" ON "FileScan"("verdict", "updatedAt");
