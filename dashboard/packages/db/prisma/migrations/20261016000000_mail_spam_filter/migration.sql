-- Polaris' own judgement of arriving mail.
--
-- The provider has already had its go by the time a message reaches here, so
-- what this catches is by definition what the provider let through. It is on by
-- default for that reason: a filter nobody switches on catches nothing.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "spamFilter" BOOLEAN NOT NULL DEFAULT true;

-- What the filter made of one message, and the heaviest thing it had to say.
-- Null is a message nothing has judged - every row written before this existed.
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "spamScore" INTEGER;
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "spamReason" TEXT NOT NULL DEFAULT '';

-- What one mailbox has learned about a word. Per mailbox, because a word that
-- means junk in a personal mailbox is often the subject matter of a work one.
CREATE TABLE IF NOT EXISTS "MailSpamToken" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "junkCount" INTEGER NOT NULL DEFAULT 0,
    "goodCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSpamToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MailSpamToken_accountId_token_key" ON "MailSpamToken"("accountId", "token");
CREATE INDEX IF NOT EXISTS "MailSpamToken_accountId_idx" ON "MailSpamToken"("accountId");

ALTER TABLE "MailSpamToken" DROP CONSTRAINT IF EXISTS "MailSpamToken_accountId_fkey";
ALTER TABLE "MailSpamToken" ADD CONSTRAINT "MailSpamToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What it has learned about a sender, a domain, or a shape of message.
CREATE TABLE IF NOT EXISTS "MailSpamReputation" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "junkCount" INTEGER NOT NULL DEFAULT 0,
    "goodCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSpamReputation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MailSpamReputation_accountId_kind_key_key" ON "MailSpamReputation"("accountId", "kind", "key");
CREATE INDEX IF NOT EXISTS "MailSpamReputation_accountId_idx" ON "MailSpamReputation"("accountId");

ALTER TABLE "MailSpamReputation" DROP CONSTRAINT IF EXISTS "MailSpamReputation_accountId_fkey";
ALTER TABLE "MailSpamReputation" ADD CONSTRAINT "MailSpamReputation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What somebody said about one message, so saying the opposite later takes the
-- first answer back rather than leaving the mailbox holding both opinions.
CREATE TABLE IF NOT EXISTS "MailSpamFeedback" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "messageKey" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "counted" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSpamFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MailSpamFeedback_accountId_messageKey_key" ON "MailSpamFeedback"("accountId", "messageKey");
CREATE INDEX IF NOT EXISTS "MailSpamFeedback_accountId_idx" ON "MailSpamFeedback"("accountId");

ALTER TABLE "MailSpamFeedback" DROP CONSTRAINT IF EXISTS "MailSpamFeedback_accountId_fkey";
ALTER TABLE "MailSpamFeedback" ADD CONSTRAINT "MailSpamFeedback_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
