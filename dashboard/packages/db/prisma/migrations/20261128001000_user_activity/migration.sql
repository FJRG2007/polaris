-- What somebody is doing right now - a game, a song - and whether they share it.
--
-- Two new tables and one new audience. Nothing is backfilled: no row in either
-- table is the defaults (share everything, from every source), and the audience
-- defaults to everybody, the same as the dot it is drawn beside. Only ever shown
-- to a reader who can already see that the person is here, so this changes what
-- anybody sees only once something is actually being played.
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "activity" TEXT NOT NULL DEFAULT 'everyone';

CREATE TABLE IF NOT EXISTS "UserActivity" (
    "userId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "linkUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("userId","source")
);

CREATE TABLE IF NOT EXISTS "UserActivitySettings" (
    "userId" UUID NOT NULL,
    "share" BOOLEAN NOT NULL DEFAULT true,
    "spotify" BOOLEAN NOT NULL DEFAULT true,
    "games" BOOLEAN NOT NULL DEFAULT true,
    "minecraft" BOOLEAN NOT NULL DEFAULT true,
    "hiddenGames" TEXT NOT NULL DEFAULT '[]',
    "customGames" TEXT NOT NULL DEFAULT '[]',
    "seenGames" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivitySettings_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX IF NOT EXISTS "UserActivity_expiresAt_idx" ON "UserActivity"("expiresAt");

ALTER TABLE "UserActivity" DROP CONSTRAINT IF EXISTS "UserActivity_userId_fkey";
ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActivitySettings" DROP CONSTRAINT IF EXISTS "UserActivitySettings_userId_fkey";
ALTER TABLE "UserActivitySettings" ADD CONSTRAINT "UserActivitySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
