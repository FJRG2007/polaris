-- Polar connectors: remote MCP servers a person connects to Polar. A new table
-- only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarConnector" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "auth" TEXT NOT NULL DEFAULT 'none',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "toolPolicies" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "lastError" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarConnector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarConnector_ownerId_name_key" ON "PolarConnector"("ownerId", "name");

ALTER TABLE "PolarConnector" DROP CONSTRAINT IF EXISTS "PolarConnector_ownerId_fkey";
ALTER TABLE "PolarConnector" ADD CONSTRAINT "PolarConnector_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
