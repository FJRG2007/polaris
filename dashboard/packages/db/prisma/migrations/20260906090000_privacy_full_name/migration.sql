-- Who may see the name on an account, as opposed to the name it shows.
--
-- The third setting that arrives shut, and for the same reason as the address
-- and the number: a display name is chosen to be seen and is what every screen
-- draws, while the name behind it is an ordinary personal detail that being in a
-- room with somebody is not consent to.
--
-- Shut for every account that already exists, which is what the default does
-- here and what an absent row already meant.
ALTER TABLE "UserPrivacy" ADD COLUMN "fullName" TEXT NOT NULL DEFAULT 'nobody';
