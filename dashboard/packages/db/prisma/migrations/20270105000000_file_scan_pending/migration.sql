-- Waiting scans are found by verdict, oldest attempt first.
CREATE INDEX "FileScan_verdict_updatedAt_idx" ON "FileScan"("verdict", "updatedAt");
