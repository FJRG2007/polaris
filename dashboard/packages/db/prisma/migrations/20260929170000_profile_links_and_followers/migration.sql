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
-- Every statement stands on its own and every one is `IF NOT EXISTS`, because a
-- migration here has to survive being run twice. The entrypoint retries
-- `migrate deploy` while the database comes up, and the update rolls a build
-- back by killing its container - so a script interrupted between two of its
-- statements is an ordinary event, and one that cannot be re-run turns it into a
-- deployment that can never migrate again. This one was written as a single
-- multi-column ALTER and did exactly that.
--
-- Widening only: every existing row keeps everything it has.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "headline" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pronouns" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "links" TEXT;

ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "followers" TEXT;
