-- A file sent in a task's thread.
--
-- It is a file on the task either way - somebody looking for "that screenshot" a
-- month later goes to the Files list rather than scrolling the conversation - and
-- this is what also lets the thread draw it where it was said.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- AlterTable
ALTER TABLE "TaskAttachment" ADD COLUMN IF NOT EXISTS "commentId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TaskAttachment_commentId_idx" ON "TaskAttachment"("commentId");
