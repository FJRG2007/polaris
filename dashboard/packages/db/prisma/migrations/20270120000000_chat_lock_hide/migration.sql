-- Chat lock and hidden chats: one reader's own code, and two marks of their own
-- on each conversation they are in.
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ChatLock" (
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "hideLocked" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatLock_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "ChatLock" DROP CONSTRAINT IF EXISTS "ChatLock_userId_fkey";
ALTER TABLE "ChatLock" ADD CONSTRAINT "ChatLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
