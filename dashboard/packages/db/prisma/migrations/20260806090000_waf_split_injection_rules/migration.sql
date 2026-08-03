-- Split the single injection refusal into the two independent controls it always was:
-- a SQL injection check and a cross-site scripting check.
--
-- Both columns are backfilled from the old one rather than taking their default, so a
-- scope that had switched injection protection off keeps both halves off instead of
-- silently re-arming on upgrade. A scope that never wrote a row is unaffected: absence
-- still means "never configured", and the defaults here are what that resolves to.
ALTER TABLE "WafRule" ADD COLUMN "sqlInjectionProtection" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WafRule" ADD COLUMN "xssProtection" BOOLEAN NOT NULL DEFAULT true;

UPDATE "WafRule" SET "sqlInjectionProtection" = "injectionProtection", "xssProtection" = "injectionProtection";

ALTER TABLE "WafRule" DROP COLUMN "injectionProtection";
