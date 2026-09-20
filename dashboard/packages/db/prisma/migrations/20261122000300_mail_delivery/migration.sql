-- What became of a message after the outgoing server took it, and whether a
-- refusal was final.
--
-- Until now the send queue was the only record of anything leaving, and it is
-- deleted the moment a message goes. So a delivery report arriving days later
-- had nothing to be about, and a message the server refused for good was retried
-- and shown as still on its way.
--
-- Every existing row keeps its current behaviour: no draft is permanent, no
-- draft is a sending check, and no deployment has a delivery on record until it
-- sends its next message.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MailDraft" ADD COLUMN IF NOT EXISTS "permanent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MailDraft" ADD COLUMN IF NOT EXISTS "probe" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "MailDelivery" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "toJson" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'accepted',
    "sentCopy" TEXT NOT NULL DEFAULT 'automatic',
    "detail" TEXT NOT NULL DEFAULT '',
    "detailFor" TEXT NOT NULL DEFAULT '',
    "reportThreadId" UUID,
    "probe" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MailDelivery_accountId_sentAt_idx" ON "MailDelivery"("accountId", "sentAt");
CREATE INDEX IF NOT EXISTS "MailDelivery_accountId_state_sentAt_idx" ON "MailDelivery"("accountId", "state", "sentAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MailDelivery_accountId_messageId_key" ON "MailDelivery"("accountId", "messageId");

-- Dropped by name first, because Postgres has no conditional form of adding a
-- constraint and a second run would otherwise fail on the one already there.
ALTER TABLE "MailDelivery" DROP CONSTRAINT IF EXISTS "MailDelivery_accountId_fkey";
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
