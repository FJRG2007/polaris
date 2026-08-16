-- When a chosen status stops applying. Null is "until I change it", which is
-- what every status set before this column existed was, so no backfill.
ALTER TABLE "User" ADD COLUMN     "presenceUntil" TIMESTAMP(3);

-- Who may forward what this account wrote. Open, like every other audience here:
-- an account that has never opened the screen has not asked for anything.
ALTER TABLE "UserPrivacy" ADD COLUMN     "forwarding" TEXT NOT NULL DEFAULT 'everyone';
