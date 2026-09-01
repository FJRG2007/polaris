-- Profiles people can be sent to, and the two things that decide what one says.
--
-- `profileOrgIds` is which of an account's organizations it shows: a JSON array
-- of ids, empty by default. Being on a roster is a fact about an organization
-- rather than a statement somebody made about themselves, so none of them is
-- published until its owner marks it.
--
-- `companies` is who may see that answer at all - the line somebody typed and the
-- organizations they marked. Open by default, unlike the address and the number
-- beside it, because a company is typed into a profile in order to appear on it.
--
-- Widening only: every existing row keeps everything it has, and every existing
-- account shows no organizations until somebody chooses one.
ALTER TABLE "User" ADD COLUMN "profileOrgIds" TEXT;

ALTER TABLE "UserPrivacy" ADD COLUMN "companies" TEXT NOT NULL DEFAULT 'everyone';
