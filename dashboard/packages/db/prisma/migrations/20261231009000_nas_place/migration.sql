-- A NAS can be placed in a Places place, and remembers which alert conditions
-- it was last seen in. Both additive: every existing connection stays as it was.
ALTER TABLE "StorageConnection" ADD COLUMN IF NOT EXISTS "placeId" UUID;
ALTER TABLE "StorageConnection" ADD COLUMN IF NOT EXISTS "nasAlertKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "StorageConnection_placeId_idx" ON "StorageConnection"("placeId");

-- A NAS's temperature and usage readings for its charts.
CREATE TABLE IF NOT EXISTS "NasSample" (
    "connectionId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuTempC" DOUBLE PRECISION,
    "diskTempMaxC" DOUBLE PRECISION,
    "diskTempAvgC" DOUBLE PRECISION,
    "usedBytes" BIGINT,
    "totalBytes" BIGINT,
    "diskTemps" JSONB,
    CONSTRAINT "NasSample_pkey" PRIMARY KEY ("connectionId", "ts")
);

CREATE INDEX IF NOT EXISTS "NasSample_ts_idx" ON "NasSample"("ts");

DO $$ BEGIN
    ALTER TABLE "NasSample" ADD CONSTRAINT "NasSample_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
