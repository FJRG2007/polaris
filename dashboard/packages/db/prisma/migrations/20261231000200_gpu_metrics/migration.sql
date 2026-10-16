-- GPU on the consumption history, and the switch that hands a service the GPU.
--
-- Nullable throughout: every row written before this, and every row from a
-- machine without an NVIDIA card, knows nothing about a GPU, and a zero there
-- would chart as an idle card that does not exist.
ALTER TABLE "MetricSample" ADD COLUMN "gpuPercent" DOUBLE PRECISION;
ALTER TABLE "MetricSample" ADD COLUMN "gpuMemUsedBytes" BIGINT;
ALTER TABLE "MetricSample" ADD COLUMN "gpuMemTotalBytes" BIGINT;
ALTER TABLE "MetricSample" ADD COLUMN "gpuTempC" DOUBLE PRECISION;
ALTER TABLE "MetricSample" ADD COLUMN "gpuPowerW" DOUBLE PRECISION;

ALTER TABLE "MetricRollup" ADD COLUMN "gpuPercentAvg" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN "gpuPercentMax" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN "gpuMemUsedBytesAvg" BIGINT;
ALTER TABLE "MetricRollup" ADD COLUMN "gpuMemTotalBytesAvg" BIGINT;
ALTER TABLE "MetricRollup" ADD COLUMN "gpuTempCAvg" DOUBLE PRECISION;
ALTER TABLE "MetricRollup" ADD COLUMN "gpuPowerWAvg" DOUBLE PRECISION;

-- Off for every existing service: nothing it runs today asked for a card.
ALTER TABLE "Application" ADD COLUMN "useGpu" BOOLEAN NOT NULL DEFAULT false;
