-- Playtime per game, for the Game Time and Game Variety badges.
--
-- One new table, nothing backfilled: the running game was never kept after it
-- closed, so time played before this is not known and is not invented.
CREATE TABLE IF NOT EXISTS "UserGameTime" (
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "lastReportAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGameTime_pkey" PRIMARY KEY ("userId","key")
);

ALTER TABLE "UserGameTime" DROP CONSTRAINT IF EXISTS "UserGameTime_userId_fkey";
ALTER TABLE "UserGameTime" ADD CONSTRAINT "UserGameTime_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
