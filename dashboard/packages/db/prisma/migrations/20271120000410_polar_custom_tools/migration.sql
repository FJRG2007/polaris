-- Custom tools, plugins and approvals of a repository's own tools
-- (apps/web/src/lib/polar/custom-tools). Rerunnable.
CREATE TABLE IF NOT EXISTS "PolarCustomTool" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "runtime" TEXT NOT NULL DEFAULT 'shell',
    "script" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "permission" TEXT NOT NULL DEFAULT 'ask',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolarCustomTool_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarCustomTool_ownerId_name_key" ON "PolarCustomTool"("ownerId", "name");

ALTER TABLE "PolarCustomTool" DROP CONSTRAINT IF EXISTS "PolarCustomTool_ownerId_fkey";
ALTER TABLE "PolarCustomTool" ADD CONSTRAINT "PolarCustomTool_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PolarPlugin" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "action" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolarPlugin_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarPlugin_ownerId_idx" ON "PolarPlugin"("ownerId");

ALTER TABLE "PolarPlugin" DROP CONSTRAINT IF EXISTS "PolarPlugin_ownerId_fkey";
ALTER TABLE "PolarPlugin" ADD CONSTRAINT "PolarPlugin_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PolarProjectToolApproval" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "repository" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolarProjectToolApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarProjectToolApproval_ownerId_repository_digest_key" ON "PolarProjectToolApproval"("ownerId", "repository", "digest");

ALTER TABLE "PolarProjectToolApproval" DROP CONSTRAINT IF EXISTS "PolarProjectToolApproval_ownerId_fkey";
ALTER TABLE "PolarProjectToolApproval" ADD CONSTRAINT "PolarProjectToolApproval_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
