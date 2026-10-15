-- Hourly per-route call counters for API keys. A new table only; nothing
-- existing changes. To reverse, drop the table.

CREATE TABLE IF NOT EXISTS "ApiKeyCallHour" (
    "apiKeyId" UUID NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "totalMs" BIGINT NOT NULL DEFAULT 0,
    "ms25" INTEGER NOT NULL DEFAULT 0,
    "ms50" INTEGER NOT NULL DEFAULT 0,
    "ms100" INTEGER NOT NULL DEFAULT 0,
    "ms250" INTEGER NOT NULL DEFAULT 0,
    "ms500" INTEGER NOT NULL DEFAULT 0,
    "ms1000" INTEGER NOT NULL DEFAULT 0,
    "ms2500" INTEGER NOT NULL DEFAULT 0,
    "ms5000" INTEGER NOT NULL DEFAULT 0,
    "msOver" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ApiKeyCallHour_pkey" PRIMARY KEY ("apiKeyId", "hour", "method", "route", "status")
);

CREATE INDEX IF NOT EXISTS "ApiKeyCallHour_hour_idx" ON "ApiKeyCallHour"("hour");

ALTER TABLE "ApiKeyCallHour" DROP CONSTRAINT IF EXISTS "ApiKeyCallHour_apiKeyId_fkey";
ALTER TABLE "ApiKeyCallHour" ADD CONSTRAINT "ApiKeyCallHour_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
