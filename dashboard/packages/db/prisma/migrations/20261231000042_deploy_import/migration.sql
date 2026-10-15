-- Site imports from a hosting panel's backup, run in the background and watched
-- from the projects screen. A new table only; nothing existing changes. To
-- reverse, drop the table.

CREATE TABLE IF NOT EXISTS "DeployImport" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "actorId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" TEXT NOT NULL DEFAULT 'unpacking',
    "done" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "projectId" UUID,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DeployImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeployImport_ownerId_startedAt_idx" ON "DeployImport"("ownerId", "startedAt");
