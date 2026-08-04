-- Who a require-login scope admits and who it refuses, as JSON arrays of
-- {ref:"<type>:<id>", from?, until?} - the principal (user, group or role) and the
-- optional unix-second window the entry applies in. SQLite-portable like the address
-- lists next to it.
--
-- Both default to the empty list on purpose: an empty allow list means "any account on
-- the instance", which is exactly what requireLogin has meant on its own until now. So
-- every existing rule keeps admitting the same people after this migration, and
-- narrowing is something an operator does deliberately rather than something an upgrade
-- does to them.
ALTER TABLE "WafRule" ADD COLUMN "loginAllowPrincipals" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "WafRule" ADD COLUMN "loginDenyPrincipals" TEXT NOT NULL DEFAULT '[]';
