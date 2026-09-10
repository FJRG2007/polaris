-- Message templates: a subject and a body somebody puts into the composer from
-- a menu. Per person, and optionally tied to one mailbox (null is every one).
-- Both owners cascade, so a template goes with the account or the mailbox it
-- belonged to rather than being offered while writing from a mailbox that no
-- longer exists.
CREATE TABLE IF NOT EXISTS "MailTemplate" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" UUID,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MailTemplate_accountId_idx" ON "MailTemplate"("accountId");

CREATE UNIQUE INDEX IF NOT EXISTS "MailTemplate_userId_name_key" ON "MailTemplate"("userId", "name");

-- A constraint has no conditional form, so each is dropped by name first: a
-- second run of this migration then puts it back rather than failing.
ALTER TABLE "MailTemplate" DROP CONSTRAINT IF EXISTS "MailTemplate_userId_fkey";
ALTER TABLE "MailTemplate" ADD CONSTRAINT "MailTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MailTemplate" DROP CONSTRAINT IF EXISTS "MailTemplate_accountId_fkey";
ALTER TABLE "MailTemplate" ADD CONSTRAINT "MailTemplate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
