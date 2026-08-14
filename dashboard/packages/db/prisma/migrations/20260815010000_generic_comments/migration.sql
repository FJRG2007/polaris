-- One discussion table for every kind of thing, instead of one that only tasks
-- had.
--
-- Same shape as the history migration before it: the new table is created and
-- every existing comment copied into it BEFORE the old one is dropped, in one
-- transaction. The self-reference is added only after the copy, so a reply whose
-- parent has not been inserted yet cannot fail the constraint part-way through.

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "parentId" UUID,
    "userId" UUID,
    "body" TEXT NOT NULL,
    "assignedToId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- Every task's discussion, carried over with its own ids so a reply still points
-- at the comment it answers.
INSERT INTO "Comment" ("id", "subjectType", "subjectId", "parentId", "userId", "body", "assignedToId", "resolvedById", "resolvedAt", "createdAt", "updatedAt")
SELECT "id", 'task', "taskId", "parentId", "userId", "body", "assignedToId", "resolvedById", "resolvedAt", "createdAt", "updatedAt"
FROM "TaskComment";

-- CreateIndex
CREATE INDEX "Comment_subjectType_subjectId_createdAt_idx" ON "Comment"("subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "TaskComment" DROP CONSTRAINT "TaskComment_taskId_fkey";

-- DropForeignKey
ALTER TABLE "TaskComment" DROP CONSTRAINT "TaskComment_userId_fkey";

-- DropForeignKey
ALTER TABLE "TaskComment" DROP CONSTRAINT "TaskComment_parentId_fkey";

-- DropTable
DROP TABLE "TaskComment";
