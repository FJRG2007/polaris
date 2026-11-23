-- Whether an authorized mailbox's provider refused the grant itself - the one
-- refusal reconnecting fixes. A mail server turning away a token the provider
-- vouched for is not that, and no longer asks anybody to reconnect.
-- Additive and rerunnable.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "grantRefused" BOOLEAN NOT NULL DEFAULT false;

-- Mailboxes paused today keep what they were paused for: every refusal an
-- authorized mailbox records is a grant refusal except the server's own.
UPDATE "MailAccount" SET "grantRefused" = true
WHERE "auth" = 'oauth' AND "state" = 'auth'
  AND "stateDetail" <> 'The mail server refused this account''s credentials.';
