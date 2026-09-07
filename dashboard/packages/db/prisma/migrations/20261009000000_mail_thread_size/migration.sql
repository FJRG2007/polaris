-- How much a conversation weighs, so a list can be read biggest first.
--
-- Held on the thread rather than summed on read: the list draws fifty rows and
-- orders by this, and an aggregate per row is fifty extra queries for one page.
-- Kept in line by the same rollup that keeps the counts in line.
ALTER TABLE "MailThread" ADD COLUMN IF NOT EXISTS "size" INTEGER NOT NULL DEFAULT 0;

-- What is already synced, added up once. Everything after this is the rollup's.
UPDATE "MailThread" AS t
SET "size" = COALESCE(m.total, 0)
FROM (
    -- Capped at what the column holds. A conversation of two gigabytes is not a
    -- real conversation, and a migration that fails on one would take the whole
    -- update with it.
    SELECT "threadId", LEAST(SUM("size"), 2147483647)::int AS total
    FROM "MailMessage"
    GROUP BY "threadId"
) AS m
WHERE m."threadId" = t."id" AND t."size" = 0;

CREATE INDEX IF NOT EXISTS "MailThread_accountId_size_idx" ON "MailThread"("accountId", "size");
