-- Hourly caller counters for API keys: the calling program's family and the
-- address, beside the per-route rollup. A new table only; nothing existing
-- changes, and hours before it have no rows (the screens say "Not recorded").
-- To reverse, drop the table.

CREATE TABLE IF NOT EXISTS "ApiKeyCallerHour" (
    "apiKeyId" UUID NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "client" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ApiKeyCallerHour_pkey" PRIMARY KEY ("apiKeyId", "hour", "client", "ip")
);

CREATE INDEX IF NOT EXISTS "ApiKeyCallerHour_hour_idx" ON "ApiKeyCallerHour"("hour");

ALTER TABLE "ApiKeyCallerHour" DROP CONSTRAINT IF EXISTS "ApiKeyCallerHour_apiKeyId_fkey";
ALTER TABLE "ApiKeyCallerHour" ADD CONSTRAINT "ApiKeyCallerHour_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
