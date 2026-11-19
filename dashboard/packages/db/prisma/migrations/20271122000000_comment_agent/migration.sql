-- Polar answering a mention in a task thread writes a comment of its own.
ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "agent" TEXT;
