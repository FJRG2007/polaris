-- A task can now say what is holding it up beyond the work it depends on: a date it
-- is waiting for, and a reason in the words of whoever recorded it. Both are empty on
-- every existing row, which is exactly what "nothing has been said about this" means,
-- so nothing is backfilled here.
ALTER TABLE "Task" ADD COLUMN "blockedUntil" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "blockedNote" TEXT NOT NULL DEFAULT '';
