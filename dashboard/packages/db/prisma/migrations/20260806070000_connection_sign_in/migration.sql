-- Whether a linked outside account may also sign its owner in.
--
-- The column defaults to false so nothing is opened by the migration itself, and
-- so a link written on somebody's behalf rather than because they authorized it
-- arrives carrying no way in. What each new link actually gets is decided in the
-- application, from what the provider is worth as a way in.
--
-- Accounts linked before this existed were linked to services Polaris does trust
-- with a sign-in (GitHub, Google), so they are switched on to match what a new
-- link of the same service gets - otherwise the people who connected earliest
-- would be the only ones who had to go and find the switch.

-- AlterTable
ALTER TABLE "UserConnection" ADD COLUMN "signInEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "UserConnection" SET "signInEnabled" = true WHERE "provider" IN ('github', 'google');
