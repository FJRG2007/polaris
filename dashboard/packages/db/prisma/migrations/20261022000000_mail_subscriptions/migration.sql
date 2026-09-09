-- Every sender that keeps sending, and the way out it published.
--
-- Written as mail arrives rather than looked for when somebody asks. The offer
-- is in the headers of every message and in the footer of the ones that carry
-- no header, so answering "what am I subscribed to" from the messages
-- themselves would mean reading a mailbox's worth of bodies at the moment
-- somebody opens a screen.
CREATE TABLE IF NOT EXISTS "MailSubscription" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "senderName" TEXT NOT NULL DEFAULT '',
    "listId" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'link',
    "source" TEXT NOT NULL DEFAULT 'header',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),

    CONSTRAINT "MailSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MailSubscription_accountId_sender_key" ON "MailSubscription"("accountId", "sender");
CREATE INDEX IF NOT EXISTS "MailSubscription_accountId_lastMessageAt_idx" ON "MailSubscription"("accountId", "lastMessageAt");

ALTER TABLE "MailSubscription" DROP CONSTRAINT IF EXISTS "MailSubscription_accountId_fkey";
ALTER TABLE "MailSubscription" ADD CONSTRAINT "MailSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
