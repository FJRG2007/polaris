-- How loudly a conversation, or a whole space, may interrupt somebody.
--
-- There was one control and it was mute: a silence with an end that also takes
-- the badge away. That answers "leave me alone about this", and it is the wrong
-- answer to the question people actually have about a busy server they follow -
-- "tell me when somebody needs me, and let me find the rest later". Using a mute
-- for that costs the unread marks, which is how the room is found later, so the
-- honest choice was between being interrupted by everything or losing track of
-- it entirely.
--
-- So a standing preference sits beside the mute rather than inside it: all,
-- mentions, or nothing. It never touches the unread marks - a channel set to
-- mentions still counts what is waiting - and the mute still does what it did.
--
-- A channel says `inherit` until somebody sets it, which means whatever its
-- space says, and a space says `all`. Both defaults are what every existing row
-- means: nobody was offered this choice, so nobody has made it.

-- AlterTable
ALTER TABLE "ChatChannelMember" ADD COLUMN     "notifyLevel" TEXT NOT NULL DEFAULT 'inherit';

-- CreateTable
CREATE TABLE "ChatSpacePreference" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "notifyLevel" TEXT NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSpacePreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSpacePreference_userId_idx" ON "ChatSpacePreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSpacePreference_spaceId_userId_key" ON "ChatSpacePreference"("spaceId", "userId");

-- AddForeignKey
ALTER TABLE "ChatSpacePreference" ADD CONSTRAINT "ChatSpacePreference_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSpacePreference" ADD CONSTRAINT "ChatSpacePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
