-- Signing in with a link emailed to the account's own address.
--
-- Per account and off by default, including for every account that already
-- exists: the way in it adds is "whoever can read that mailbox", which is a
-- trade nobody should be entered into without saying so. An account turns it on
-- for itself under Account > Security.

-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN     "emailLinkSignIn" BOOLEAN NOT NULL DEFAULT false;
