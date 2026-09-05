-- A long job somebody started in Drive, still going after they closed the tab.
--
-- Trashing thousands of files was a loop of one server action per file, each
-- opening its own connection to the storage and closing it again. The work is a
-- row now: a worker takes it a batch at a time over one open driver, writes down
-- how far it has got, and the screen reads that.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- CreateTable
CREATE TABLE IF NOT EXISTS "DriveJob" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pending" TEXT NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DriveJob_ownerId_state_idx" ON "DriveJob"("ownerId", "state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DriveJob_state_leaseUntil_idx" ON "DriveJob"("state", "leaseUntil");
