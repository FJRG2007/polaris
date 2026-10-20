-- The ad blocker's long-term statistics: one row per finished UTC day, rolled
-- up from the DNS server's own log before it is deleted. Additive.
CREATE TABLE IF NOT EXISTS "DnsBlockerDay" (
    "day" DATE NOT NULL,
    "queries" INTEGER NOT NULL,
    "blocked" INTEGER NOT NULL,
    "clients" INTEGER NOT NULL,
    "hourly" JSONB NOT NULL,
    "topPermitted" JSONB NOT NULL,
    "topBlocked" JSONB NOT NULL,
    "topClients" JSONB NOT NULL,
    "topBlockedClients" JSONB NOT NULL,
    "blockedBy" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DnsBlockerDay_pkey" PRIMARY KEY ("day")
);
