-- Whether opening the screen a badge points at clears it, and how far each
-- account has seen each badge's subject.
--
-- Every statement is written so that running it a second time is a no-op. Postgres
-- does not roll a migration back statement by statement, so one that fails halfway
-- leaves what came before it applied and the history marked failed - and the
-- deployment then re-runs this file from the top.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "badgesClearOnVisit" BOOLEAN;

CREATE TABLE IF NOT EXISTS "UserBadgeSeen" (
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mark" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBadgeSeen_pkey" PRIMARY KEY ("userId","key")
);

ALTER TABLE "UserBadgeSeen" DROP CONSTRAINT IF EXISTS "UserBadgeSeen_userId_fkey";
ALTER TABLE "UserBadgeSeen" ADD CONSTRAINT "UserBadgeSeen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
