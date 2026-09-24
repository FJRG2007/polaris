-- What Polaris knows about each Docker volume it has seen on a machine, kept
-- after the app or database that made it is gone: what it was, when a running
-- container last used it, and when its owner was deleted. No foreign keys, on
-- purpose - these rows exist to outlive what they describe.
CREATE TABLE IF NOT EXISTS "HostResourceRecord" (
    "id" UUID NOT NULL,
    "serverId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'other',
    "description" TEXT NOT NULL,
    "sourceKind" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "ownerDeletedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "HostResourceRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "HostResourceRecord_serverId_kind_name_key" ON "HostResourceRecord"("serverId", "kind", "name");
CREATE INDEX IF NOT EXISTS "HostResourceRecord_sourceKind_sourceId_idx" ON "HostResourceRecord"("sourceKind", "sourceId");
