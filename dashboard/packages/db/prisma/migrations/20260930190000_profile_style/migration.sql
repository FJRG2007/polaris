-- What somebody has chosen their profile to look like.
--
-- Catalogue ids and colours, never files: nothing here is served, so there is no
-- storage, no moderation queue and nothing to fetch before a face can be drawn.
-- A profile with no row is the ordinary profile, which is almost all of them.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserProfileStyle" (
    "userId" UUID NOT NULL,
    "banner" TEXT,
    "decoration" TEXT,
    "nameplate" TEXT,
    "effect" TEXT,
    "nameStyle" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfileStyle_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserProfileStyle" DROP CONSTRAINT IF EXISTS "UserProfileStyle_userId_fkey";
ALTER TABLE "UserProfileStyle" ADD CONSTRAINT "UserProfileStyle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
