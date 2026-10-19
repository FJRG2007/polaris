-- Polar's sidebar: pinned and archived chats, projects (folders whose
-- instructions reach the model), and a read-only public link per chat.
-- Existing threads stay unpinned, unarchived and outside any project, which is
-- exactly how they were listed before.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarProject" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarProject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarProject_ownerId_updatedAt_idx" ON "PolarProject"("ownerId", "updatedAt" DESC);

ALTER TABLE "PolarProject" DROP CONSTRAINT IF EXISTS "PolarProject_ownerId_fkey";
ALTER TABLE "PolarProject" ADD CONSTRAINT "PolarProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "projectId" UUID;

CREATE INDEX IF NOT EXISTS "PolarThread_userId_archivedAt_pinnedAt_idx" ON "PolarThread"("userId", "archivedAt", "pinnedAt");
CREATE INDEX IF NOT EXISTS "PolarThread_projectId_updatedAt_idx" ON "PolarThread"("projectId", "updatedAt" DESC);

ALTER TABLE "PolarThread" DROP CONSTRAINT IF EXISTS "PolarThread_projectId_fkey";
ALTER TABLE "PolarThread" ADD CONSTRAINT "PolarThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PolarProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PolarThreadShare" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" BYTEA NOT NULL,
    "tokenNonce" BYTEA NOT NULL,
    "tokenKeyId" TEXT NOT NULL,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarThreadShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarThreadShare_threadId_key" ON "PolarThreadShare"("threadId");
CREATE UNIQUE INDEX IF NOT EXISTS "PolarThreadShare_tokenHash_key" ON "PolarThreadShare"("tokenHash");

ALTER TABLE "PolarThreadShare" DROP CONSTRAINT IF EXISTS "PolarThreadShare_threadId_fkey";
ALTER TABLE "PolarThreadShare" ADD CONSTRAINT "PolarThreadShare_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PolarThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
