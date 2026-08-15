-- Replying to a message, and forwarding one.
--
-- One column pair for both, because they are the same relationship - this
-- message stands on that one - and only the wording and the placement differ.
--
-- Distinct from parentId, which puts a message inside a thread and takes it out
-- of the channel. A reply stays in the flow with the thing it answers above it,
-- which is what people reach for far more often; a thread is the alternative.
--
-- ON DELETE SET NULL: deleting what was quoted must not delete the answer. The
-- quote falls back to saying the original is gone.
--
-- Additive: every existing message quotes nothing and is not a forward.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "forwarded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyToId" UUID;

-- CreateIndex
CREATE INDEX "ChatMessage_replyToId_idx" ON "ChatMessage"("replyToId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

