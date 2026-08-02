-- Files and commits attached to a task.
--
-- A task manager where the screenshot lives in a chat and the commit lives in a
-- browser tab is a task manager that only holds half of what happened. Both are
-- pointers rather than content: the bytes go wherever the instance keeps its
-- uploads (a NAS it already has a connection to, or its own disk), and a commit
-- is recorded as what it said at the time.
--
-- TaskAttachment.connectionId deliberately has no foreign key. A storage
-- connection can be removed while files it holds are still described here, and a
-- pointer that cannot be resolved is more honest than a row that vanished with
-- the connection - the file may well still be on the NAS.
--
-- TaskCommit is unique per (task, repository, sha): linking the same commit
-- twice is a mistake somebody makes, not something to record twice.

-- CreateTable
CREATE TABLE "TaskAttachment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCommit" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "repository" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "authorName" TEXT NOT NULL DEFAULT '',
    "committedAt" TIMESTAMP(3),
    "linkedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCommit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskAttachment_taskId_idx" ON "TaskAttachment"("taskId");

-- CreateIndex
CREATE INDEX "TaskCommit_taskId_idx" ON "TaskCommit"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskCommit_taskId_repository_sha_key" ON "TaskCommit"("taskId", "repository", "sha");

-- AddForeignKey
ALTER TABLE "TaskAttachment" ADD CONSTRAINT "TaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCommit" ADD CONSTRAINT "TaskCommit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
