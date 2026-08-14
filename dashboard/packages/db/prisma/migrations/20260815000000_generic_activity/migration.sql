-- One history table for every kind of thing, instead of one that only tasks had.
--
-- The order matters and is the whole point: the new table is created and every
-- existing line is copied into it BEFORE the old one is dropped, in one
-- transaction, so a failure anywhere leaves the old table exactly as it was and
-- a success leaves nothing behind.

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_subjectType_subjectId_createdAt_idx" ON "Activity"("subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_userId_createdAt_idx" ON "Activity"("userId", "createdAt");

-- Every task's history, carried over with its own ids so nothing is renumbered.
INSERT INTO "Activity" ("id", "subjectType", "subjectId", "userId", "action", "fromValue", "toValue", "createdAt")
SELECT "id", 'task', "taskId", "userId", "action", "fromValue", "toValue", "createdAt"
FROM "TaskActivity";

-- DropForeignKey
ALTER TABLE "TaskActivity" DROP CONSTRAINT "TaskActivity_taskId_fkey";

-- DropTable
DROP TABLE "TaskActivity";
