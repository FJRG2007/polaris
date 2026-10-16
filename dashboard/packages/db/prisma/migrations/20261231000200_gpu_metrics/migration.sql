-- GPU on the consumption history, and the switch that hands a service the GPU.
--
-- Nullable throughout: every row written before this, and every row from a
-- machine without an NVIDIA card, knows nothing about a GPU, and a zero there
-- would chart as an idle card that does not exist.
ALTER TABLE "MetricSample" ADD COLUMN IF NOT EXISTS "gpuPercent" DOUBLE PRECISION;
ALTER TABLE "MetricSample" ADD COLUMN IF NOT EXISTS "gpuMemUsedBytes" BIGINT;
ALTER TABLE "MetricSample" ADD COLUMN IF NOT EXISTS "gpuMemTotalBytes" BIGINT;
ALTER TABLE "MetricSample" ADD COLUMN IF NOT EXISTS "gpuTempC" DOUBLE PRECISION;
ALTER TABLE "MetricSample" ADD COLUMN IF NOT EXISTS "gpuPowerW" DOUBLE PRECISION;

ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuPercentAvg" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuPercentMax" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuMemUsedBytesAvg" BIGINT;
ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuMemTotalBytesAvg" BIGINT;
ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuTempCAvg" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN IF NOT EXISTS "gpuPowerWAvg" DOUBLE PRECISION;

-- Off for every existing service: nothing it runs today asked for a card.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "useGpu" BOOLEAN NOT NULL DEFAULT false;
