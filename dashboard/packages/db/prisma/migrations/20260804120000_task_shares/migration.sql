-- A read-only public link to one task.
--
-- Work does not stop at the edge of the account list: a client wants to see
-- where their thing is, and the alternative to a link is a screenshot pasted
-- into an email, which is stale the moment it is sent.
--
-- One row per task, and the token is the whole credential. Turning the link off
-- deletes the row rather than flagging it, so switching it back on mints a new
-- token and anything pasted elsewhere stops resolving for good. `views` is the
-- only thing the public page writes back, so an owner can tell a link nobody
-- opened from one that is being read.

-- CreateTable
CREATE TABLE "TaskShare" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "showComments" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskShare_taskId_key" ON "TaskShare"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskShare_token_key" ON "TaskShare"("token");

-- AddForeignKey
ALTER TABLE "TaskShare" ADD CONSTRAINT "TaskShare_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
