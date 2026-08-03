-- Whether a linked outside account may also sign its owner in.
--
-- The column defaults to false so a provider added later - one Polaris does not
-- recommend as a way in - starts closed for everybody rather than opening the
-- moment somebody links an account of it. Accounts linked before this existed
-- were linked to services Polaris does trust with a sign-in (GitHub, Google), so
-- they are switched on to match what a new link of the same service gets. Nobody
-- is let in by that on its own: the operator's own switch is off until they turn
-- it on, and both have to allow it.

-- AlterTable
ALTER TABLE "UserConnection" ADD COLUMN "signInEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "UserConnection" SET "signInEnabled" = true WHERE "provider" IN ('github', 'google');
