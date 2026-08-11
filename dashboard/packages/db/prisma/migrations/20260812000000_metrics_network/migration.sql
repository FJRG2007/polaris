-- Bandwidth on the consumption history. The raw columns are the container's own
-- cumulative counters, in each direction; the rollup columns are how far those
-- counters advanced inside the hour, which is the only aggregate of a counter
-- that means anything. Nullable throughout: every row written before this knows
-- nothing about network, and a zero there would chart as an hour of silence.
ALTER TABLE "MetricSample" ADD COLUMN "netRxBytes" BIGINT;
ALTER TABLE "MetricSample" ADD COLUMN "netTxBytes" BIGINT;

ALTER TABLE "MetricRollup" ADD COLUMN "netRxBytesSum" BIGINT;
ALTER TABLE "MetricRollup" ADD COLUMN "netTxBytesSum" BIGINT;
