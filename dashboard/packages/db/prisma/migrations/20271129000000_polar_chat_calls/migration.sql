-- A change Polar wants to make after an @polar mention in Chat, waiting on the
-- person who asked to approve it.
--
-- Additive only: one new table. Written to be safe to run twice. The
-- entrypoint retries migrations, and an update can kill the container
-- part-way through one.
CREATE TABLE IF NOT EXISTS "PolarChatCall" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "mentionId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "done" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarChatCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarChatCall_messageId_idx" ON "PolarChatCall"("messageId");

CREATE INDEX IF NOT EXISTS "PolarChatCall_createdAt_idx" ON "PolarChatCall"("createdAt");

DO $$
BEGIN
    ALTER TABLE "PolarChatCall"
        ADD CONSTRAINT "PolarChatCall_ownerId_fkey"
        FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "PolarChatCall"
        ADD CONSTRAINT "PolarChatCall_messageId_fkey"
        FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
