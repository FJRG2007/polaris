-- Polaris Terminal instances reachable through the remote-control relay
-- (docs/terminal-integration.md). One row per terminal key.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "TerminalInstance";
CREATE TABLE IF NOT EXISTS "TerminalInstance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "apiKeyId" UUID NOT NULL,
    "name" TEXT,
    "os" TEXT,
    "version" TEXT,
    "relayNode" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TerminalInstance_apiKeyId_key" ON "TerminalInstance"("apiKeyId");
CREATE INDEX IF NOT EXISTS "TerminalInstance_userId_idx" ON "TerminalInstance"("userId");

DO $$
BEGIN
    ALTER TABLE "TerminalInstance"
        ADD CONSTRAINT "TerminalInstance_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "TerminalInstance"
        ADD CONSTRAINT "TerminalInstance_apiKeyId_fkey"
        FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
