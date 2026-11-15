-- The Telegram chat an account's second-factor codes go to, bound by a one-time
-- start link (lib/messaging/telegram-link.ts). Rerunnable.
CREATE TABLE IF NOT EXISTS "UserTelegram" (
    "userId" UUID NOT NULL,
    "chatId" TEXT,
    "username" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "linkTokenHash" TEXT,
    "linkExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTelegram_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX IF NOT EXISTS "UserTelegram_linkTokenHash_idx" ON "UserTelegram"("linkTokenHash");

ALTER TABLE "UserTelegram" DROP CONSTRAINT IF EXISTS "UserTelegram_userId_fkey";
ALTER TABLE "UserTelegram" ADD CONSTRAINT "UserTelegram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
