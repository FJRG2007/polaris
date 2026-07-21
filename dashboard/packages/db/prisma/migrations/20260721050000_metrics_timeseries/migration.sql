-- Time-series consumption history for deployed apps and Drive NAS/servers.
-- Raw samples (short retention) plus hourly rollups (long retention); the
-- collector fills them and prunes past the retention windows.
CREATE TABLE "MetricSample" (
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPercent" DOUBLE PRECISION,
    "cpuTempC" DOUBLE PRECISION,
    "memUsedBytes" BIGINT,
    "memTotalBytes" BIGINT,
    "diskUsedBytes" BIGINT,
    "diskTotalBytes" BIGINT,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("subjectType","subjectId","ts")
);

CREATE INDEX "MetricSample_ts_idx" ON "MetricSample"("ts");

CREATE TABLE "MetricRollup" (
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "cpuPercentAvg" DOUBLE PRECISION,
    "cpuPercentMax" DOUBLE PRECISION,
    "cpuTempCAvg" DOUBLE PRECISION,
    "memUsedBytesAvg" BIGINT,
    "memTotalBytesAvg" BIGINT,
    "diskUsedBytesAvg" BIGINT,
    "diskTotalBytesAvg" BIGINT,
    "samples" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MetricRollup_pkey" PRIMARY KEY ("subjectType","subjectId","bucket")
);

CREATE INDEX "MetricRollup_bucket_idx" ON "MetricRollup"("bucket");
