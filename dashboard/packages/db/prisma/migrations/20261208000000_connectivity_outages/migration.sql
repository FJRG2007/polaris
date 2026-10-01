-- Connectivity outages: every stretch this deployment could not be reached from
-- outside or could not reach out, as the address watcher saw it, plus a monthly
-- roll-up for the ones older than the retention window.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConnectivityOutage" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastUpAt" TIMESTAMP(3),
    "detectedBy" TEXT,
    "detail" TEXT,
    "firstBack" TEXT,
    "firstBackAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "blips" INTEGER NOT NULL DEFAULT 0,
    "openSlot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectivityOutage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConnectivityOutageMonth" (
    "id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "downtimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "longestSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ConnectivityOutageMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectivityOutage_openSlot_key" ON "ConnectivityOutage"("openSlot");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConnectivityOutage_startedAt_idx" ON "ConnectivityOutage"("startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConnectivityOutage_endedAt_idx" ON "ConnectivityOutage"("endedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectivityOutageMonth_month_kind_key" ON "ConnectivityOutageMonth"("month", "kind");
