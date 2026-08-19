-- What an account says about itself, and what it is saying right now.
--
-- Two different things on purpose. A description is a fact about the person that
-- changes once a year; a status is a line about this afternoon, and the column
-- beside it is what stops it outliving the afternoon. Nothing sweeps a lapsed
-- one: it is worked out when it is read, so no job has to run for it to be
-- right.
--
-- Both default to empty, so every existing account has no description and no
-- status - which is exactly what they had before this ran.
ALTER TABLE "User" ADD COLUMN "description" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "statusText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "statusUntil" TIMESTAMP(3);
