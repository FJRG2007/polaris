-- What a session signed in with, and the scratch space the record travels in.
--
-- A sign-in and the session row Polaris keeps beside it are written by different
-- requests, and a second factor makes it three of them, so each step leaves what
-- it learned on the account and the session collects it when its state row is
-- written. Existing sessions keep null in both columns and read as unrecorded.

-- AlterTable
ALTER TABLE "SessionState" ADD COLUMN "signInMethod" TEXT,
                           ADD COLUMN "secondFactor" TEXT;

-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN "pendingSignInMethod" TEXT,
                           ADD COLUMN "pendingSignInFactor" TEXT,
                           ADD COLUMN "pendingSignInAt" TIMESTAMP(3);
