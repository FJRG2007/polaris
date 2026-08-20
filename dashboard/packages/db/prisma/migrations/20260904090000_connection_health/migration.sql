-- A connected account that has stopped working, and whether its owner has been
-- told.
--
-- A token expires quietly. Nothing announces it, and the first sign is a deploy
-- failing at the clone with git asking a terminal that does not exist for a
-- username - which reads like anything but "the account you linked three weeks
-- ago ran out". So the link records the last time it was known to work, and
-- which announcement its owner has already had, so the sweep that checks them
-- says it once rather than every time it runs.
--
-- Empty is the state every existing link is in: nothing has gone wrong with it,
-- or nothing has looked yet. Both mean the same thing here - nobody is owed an
-- announcement - which is why this lands on a live deployment without changing
-- anything about it.
ALTER TABLE "UserConnection" ADD COLUMN "healthNotice" TEXT NOT NULL DEFAULT '';
ALTER TABLE "UserConnection" ADD COLUMN "checkedAt" TIMESTAMP(3);
