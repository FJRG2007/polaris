-- One "who hears about this" table for every kind of thing, instead of one that
-- only tasks had.
--
-- Same shape as the two before it: create, copy, then drop, in one transaction.
-- Everyone watching a task carries over as an explicit follower, because that is
-- what watching a task was.

-- CreateTable
CREATE TABLE "Follow" (
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'explicit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("subjectType","subjectId","userId")
);

INSERT INTO "Follow" ("subjectType", "subjectId", "userId", "reason")
SELECT 'task', "taskId", "userId", 'explicit'
FROM "TaskWatcher";

-- CreateIndex
CREATE INDEX "Follow_userId_idx" ON "Follow"("userId");

-- CreateIndex
CREATE INDEX "Follow_subjectType_subjectId_idx" ON "Follow"("subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "TaskWatcher" DROP CONSTRAINT "TaskWatcher_taskId_fkey";

-- DropForeignKey
ALTER TABLE "TaskWatcher" DROP CONSTRAINT "TaskWatcher_userId_fkey";

-- DropTable
DROP TABLE "TaskWatcher";
