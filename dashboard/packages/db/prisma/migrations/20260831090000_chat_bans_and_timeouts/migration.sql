-- Keeping somebody out of a space, and keeping somebody quiet for a while.
--
-- Two different things on purpose. A timeout is a moment rather than a flag, so
-- it ends on its own: one that has to be remembered and lifted becomes a ban by
-- accident. A ban is a row, checked wherever anybody is added or an invitation
-- is followed, so it survives being forgotten about.
--
-- Only a space has bans. A group is people who got there by invitation from
-- somebody already in it - there is no door to stand at, so removing somebody is
-- all there is to do.
--
-- Both columns are nullable and every existing row is left alone: nobody is
-- timed out and nobody is banned until somebody says so.
ALTER TABLE "ChatSpaceMember" ADD COLUMN "timeoutUntil" TIMESTAMP(3);
ALTER TABLE "ChatChannelMember" ADD COLUMN "timeoutUntil" TIMESTAMP(3);

CREATE TABLE "ChatSpaceBan" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    -- Null once the account that decided is gone: the ban outlives whoever made
    -- it, which is the point of writing it down.
    "byId" UUID,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSpaceBan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatSpaceBan_spaceId_userId_key" ON "ChatSpaceBan"("spaceId", "userId");
CREATE INDEX "ChatSpaceBan_spaceId_idx" ON "ChatSpaceBan"("spaceId");

ALTER TABLE "ChatSpaceBan" ADD CONSTRAINT "ChatSpaceBan_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSpaceBan" ADD CONSTRAINT "ChatSpaceBan_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSpaceBan" ADD CONSTRAINT "ChatSpaceBan_byId_fkey"
    FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
