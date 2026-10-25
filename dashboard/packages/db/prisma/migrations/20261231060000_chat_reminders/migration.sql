-- Reminders on chat messages: additive. Nobody has one until they set one.
CREATE TABLE IF NOT EXISTS "ChatReminder" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firedAt" TIMESTAMP(3),

    CONSTRAINT "ChatReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatReminder_userId_messageId_key" ON "ChatReminder"("userId", "messageId");
CREATE INDEX IF NOT EXISTS "ChatReminder_firedAt_dueAt_idx" ON "ChatReminder"("firedAt", "dueAt");
CREATE INDEX IF NOT EXISTS "ChatReminder_userId_firedAt_dueAt_idx" ON "ChatReminder"("userId", "firedAt", "dueAt");
ALTER TABLE "ChatReminder" DROP CONSTRAINT IF EXISTS "ChatReminder_userId_fkey";
ALTER TABLE "ChatReminder" ADD CONSTRAINT "ChatReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatReminder" DROP CONSTRAINT IF EXISTS "ChatReminder_messageId_fkey";
ALTER TABLE "ChatReminder" ADD CONSTRAINT "ChatReminder_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
