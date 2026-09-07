-- The tabs above the mail list, and the one setting that acts on them.
--
-- `category` is empty for every message that already exists, and that is
-- deliberate: empty means "nothing has decided yet", so the column is its own
-- backfill queue. A scheduled pass fills it in batches, oldest mailbox first,
-- and stops existing once there is nothing left to do - which is what makes the
-- sorting retroactive without anybody being asked to resync a mailbox.
--
-- `securityKeepMinutes` is zero, which is off. Throwing away somebody's mail
-- without being asked is not a thing to opt out of.
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "securityKeepMinutes" INTEGER NOT NULL DEFAULT 0;

-- Narrowing a list to one tab is the commonest query this app will ever run.
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_category_sentAt_idx"
    ON "MailMessage" ("accountId", "category", "sentAt");
