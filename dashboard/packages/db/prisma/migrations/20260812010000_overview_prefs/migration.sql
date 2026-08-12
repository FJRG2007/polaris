-- How each account has arranged its Overview: which cards it draws, in what
-- order and size, and the links pinned above them. Stringified JSON like the
-- other per-account preference columns, and nullable: an account that has never
-- arranged anything follows the catalogue.
ALTER TABLE "User" ADD COLUMN "overviewPrefs" TEXT;
