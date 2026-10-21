-- The network filter's remembered Dymo verdicts, one row per domain. A new
-- table only; nothing existing changes, and it is a no-op when run a second time.
CREATE TABLE IF NOT EXISTS "DnsReputation" (
    "domain" TEXT NOT NULL,
    "fraud" BOOLEAN NOT NULL DEFAULT false,
    "adult" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DnsReputation_pkey" PRIMARY KEY ("domain")
);

CREATE INDEX IF NOT EXISTS "DnsReputation_flagged_checkedAt_idx" ON "DnsReputation"("flagged", "checkedAt");
CREATE INDEX IF NOT EXISTS "DnsReputation_expiresAt_idx" ON "DnsReputation"("expiresAt");
