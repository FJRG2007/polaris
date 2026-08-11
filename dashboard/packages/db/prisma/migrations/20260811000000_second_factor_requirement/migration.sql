-- An account can now meet the instance's second-factor requirement with an email
-- code rather than an authenticator. better-auth arms one factor either way and
-- mints a TOTP secret for it, so that path leaves a secret nobody was shown; this
-- marks the accounts it belongs to, and everything that would offer an
-- authenticator reads it before doing so.
--
-- No backfill: false is correct for every account that exists. A factor armed
-- before this column did not exist was armed by scanning a QR code, which is the
-- only way there was.
ALTER TABLE "UserSecurity" ADD COLUMN "totpUnclaimed" BOOLEAN NOT NULL DEFAULT false;
