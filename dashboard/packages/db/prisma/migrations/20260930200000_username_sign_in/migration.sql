-- Whether an account can be signed in to by its username as well as by its
-- address.
--
-- On by default, because it is how every existing account already works and
-- turning it off for everybody would lock out whoever signs in that way. It is
-- worth turning off, and the screen says so: a username is public here - it is
-- how somebody is mentioned, searched for and linked to - so leaving it on
-- publishes the first half of the credential.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "usernameSignIn" BOOLEAN NOT NULL DEFAULT true;
