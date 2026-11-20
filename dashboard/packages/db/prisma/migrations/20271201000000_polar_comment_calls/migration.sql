-- @polar in a task's thread answers with the asker's tools: a change it wants
-- to make waits on the person who asked, and Polar's comment carries the
-- Approve/Cancel or Try again buttons.
--
-- Additive only: one nullable column and one new table. Written to be safe to
-- run twice. The entrypoint retries migrations, and an update can kill the
-- container part-way through one.
ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "components" JSONB;

CREATE TABLE IF NOT EXISTS "PolarCommentCall" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "mentionId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "done" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarCommentCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarCommentCall_commentId_idx" ON "PolarCommentCall"("commentId");

CREATE INDEX IF NOT EXISTS "PolarCommentCall_createdAt_idx" ON "PolarCommentCall"("createdAt");

ALTER TABLE "PolarCommentCall" DROP CONSTRAINT IF EXISTS "PolarCommentCall_ownerId_fkey";
ALTER TABLE "PolarCommentCall" ADD CONSTRAINT "PolarCommentCall_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarCommentCall" DROP CONSTRAINT IF EXISTS "PolarCommentCall_commentId_fkey";
ALTER TABLE "PolarCommentCall" ADD CONSTRAINT "PolarCommentCall_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
