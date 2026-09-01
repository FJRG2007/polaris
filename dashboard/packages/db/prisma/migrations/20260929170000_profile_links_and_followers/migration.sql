-- A profile that says more than a name, and the two lists behind following
-- somebody.
--
-- `headline` is the one line under the name and is deliberately not the
-- description beside it: one is read in a list and the other is a paragraph
-- nobody reads in a list. `pronouns` is in somebody's own words, empty meaning
-- they have not said rather than a field waiting to be filled. `links` is a JSON
-- array of `{ label, url }` - a portfolio, a site, a linktree.
--
-- `UserPrivacy.followers` is nullable on purpose. Null is "nobody has chosen",
-- and what that resolves to is the operator's setting rather than a number
-- frozen into this column: an instance meant as a company directory and one
-- meant as a place people follow each other want opposite answers, and only the
-- person running it can say which this is.
--
-- Widening only: every existing row keeps everything it has.
ALTER TABLE "User" ADD COLUMN "headline" TEXT,
ADD COLUMN "pronouns" TEXT,
ADD COLUMN "links" TEXT;

ALTER TABLE "UserPrivacy" ADD COLUMN "followers" TEXT;
