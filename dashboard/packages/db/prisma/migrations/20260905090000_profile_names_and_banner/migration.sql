-- What somebody is called, and what they are called.
--
-- `name` has always been both: the label drawn beside every message and the
-- nearest thing the account had to a person's name. They are not the same
-- question - a display name is chosen and can be anything, a name has a first
-- half and a last half and is asked for on every form there is - so the two
-- halves get columns of their own and `name` becomes what it always was in
-- practice, the label.
--
-- Both are nullable and nothing reads them to draw anything: every account that
-- exists today has neither, and each keeps working exactly as it did.
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

-- The wide picture across the top of a profile. Same shape as "UserAvatar",
-- because it is the same arrangement: the bytes go to whatever storage this
-- instance keeps uploads on and the row records which one and where, so a
-- picture written before a NAS was connected stays readable on the disk it went
-- to. One row per account - a new banner replaces the old one.
CREATE TABLE "UserBanner" (
    "userId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBanner_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserBanner" ADD CONSTRAINT "UserBanner_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
