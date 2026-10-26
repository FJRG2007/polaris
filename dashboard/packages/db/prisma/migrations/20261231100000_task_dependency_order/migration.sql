-- A task's dependencies can be arranged by hand. One edge is drawn on two
-- tasks - in the blocker's "blocking" list and in the blocked task's "waiting
-- on" list - so it carries one order key for each.
--
-- Additive: two columns and two indexes are new, nothing is removed. Until now
-- both lists were read with no ORDER BY, so the order on screen was the order
-- rows were written in; the backfill numbers every existing edge by when it was
-- linked (then by id, which is time-ordered) so each list keeps that order.
--
-- Every statement is a no-op the second time: the columns start nullable and
-- only rows still without a key are numbered, so a rerun never undoes an order
-- somebody has since arranged.
-- To reverse: DROP INDEX "TaskDependency_blockerId_blockingOrder_idx"; DROP
-- INDEX "TaskDependency_blockedId_waitingOrder_idx"; ALTER TABLE
-- "TaskDependency" DROP COLUMN "blockingOrder", DROP COLUMN "waitingOrder".
ALTER TABLE "TaskDependency" ADD COLUMN IF NOT EXISTS "blockingOrder" DOUBLE PRECISION;
ALTER TABLE "TaskDependency" ADD COLUMN IF NOT EXISTS "waitingOrder" DOUBLE PRECISION;

UPDATE "TaskDependency" AS edge
SET "blockingOrder" = ranked.position * 1024
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "blockerId" ORDER BY "createdAt", "id") AS position
    FROM "TaskDependency"
) AS ranked
WHERE edge."id" = ranked."id" AND edge."blockingOrder" IS NULL;

UPDATE "TaskDependency" AS edge
SET "waitingOrder" = ranked.position * 1024
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "blockedId" ORDER BY "createdAt", "id") AS position
    FROM "TaskDependency"
) AS ranked
WHERE edge."id" = ranked."id" AND edge."waitingOrder" IS NULL;

ALTER TABLE "TaskDependency" ALTER COLUMN "blockingOrder" SET DEFAULT 1024;
ALTER TABLE "TaskDependency" ALTER COLUMN "blockingOrder" SET NOT NULL;
ALTER TABLE "TaskDependency" ALTER COLUMN "waitingOrder" SET DEFAULT 1024;
ALTER TABLE "TaskDependency" ALTER COLUMN "waitingOrder" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "TaskDependency_blockerId_blockingOrder_idx" ON "TaskDependency"("blockerId", "blockingOrder");
CREATE INDEX IF NOT EXISTS "TaskDependency_blockedId_waitingOrder_idx" ON "TaskDependency"("blockedId", "waitingOrder");
