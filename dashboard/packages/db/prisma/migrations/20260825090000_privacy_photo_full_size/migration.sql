-- Whether somebody may open this account's photo and look at it full size, which
-- is a separate question from whether the photo is shown at all. Open, like
-- every other audience here except the address and the number: an account that
-- has never opened the screen has not asked for anything.
ALTER TABLE "UserPrivacy" ADD COLUMN     "photoFullSize" TEXT NOT NULL DEFAULT 'everyone';
