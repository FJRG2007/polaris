-- Polar Code's spare containers move out of the settings table into one of
-- their own: one row per account, counted per server and swept by expiry.
-- Additive. The old `polar.code.spare.u.*` settings rows are removed by the
-- spare sweep itself, and their containers by the leftover sweep. Running it
-- twice is a no-op. To reverse: drop the table.
CREATE TABLE IF NOT EXISTS "AgentSpare" (
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "hostId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSpare_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSpare_sessionId_key" ON "AgentSpare"("sessionId");
CREATE INDEX IF NOT EXISTS "AgentSpare_hostId_expiresAt_idx" ON "AgentSpare"("hostId", "expiresAt");
CREATE INDEX IF NOT EXISTS "AgentSpare_expiresAt_idx" ON "AgentSpare"("expiresAt");
