-- The links in a chat message that a reputation service flagged. Additive
-- only.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatMessageLinkFlag" (
    "messageId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageLinkFlag_pkey" PRIMARY KEY ("messageId","url")
);

-- AddForeignKey
ALTER TABLE "ChatMessageLinkFlag" DROP CONSTRAINT IF EXISTS "ChatMessageLinkFlag_messageId_fkey";
ALTER TABLE "ChatMessageLinkFlag" ADD CONSTRAINT "ChatMessageLinkFlag_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
