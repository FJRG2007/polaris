-- A send a device kept offline, once taken, so a replay of it is answered with
-- the message already queued instead of sending it twice (MailSendKey).
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE IF EXISTS "MailSendKey";
CREATE TABLE IF NOT EXISTS "MailSendKey" (
    "key" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "draftId" UUID,
    "sendAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailSendKey_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "MailSendKey_expiresAt_idx" ON "MailSendKey"("expiresAt");
