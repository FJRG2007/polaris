-- Which shelf a mailbox appears on.
--
-- Null is somebody's own mailbox, which is every row that exists today. A value
-- is a mailbox that is part of an organization's work: handed out by whoever
-- runs it, and still reached by exactly one person - the `userId` beside it.
-- The column says where the mailbox is listed and nothing about who may read it.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "orgId" UUID;

CREATE INDEX IF NOT EXISTS "MailAccount_orgId_idx" ON "MailAccount"("orgId");

ALTER TABLE "MailAccount" DROP CONSTRAINT IF EXISTS "MailAccount_orgId_fkey";
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
