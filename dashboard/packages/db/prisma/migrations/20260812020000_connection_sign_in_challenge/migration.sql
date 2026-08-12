-- Whether this account wants the second-factor challenge after signing in with a
-- connected GitHub or Google account. Off by default: that sign-in already ran
-- another account's own gates, and the instance policy is what raises the
-- challenge for everybody when an operator wants it raised.
ALTER TABLE "UserSecurity" ADD COLUMN "challengeConnectionSignIn" BOOLEAN NOT NULL DEFAULT false;
