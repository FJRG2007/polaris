-- Which second factors an account accepts, how strict its sign-in is, and the
-- factors a sign-in still owes. Additive and rerunnable; existing rows take the
-- defaults, which accept every method already set up.
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "twoFactorRefused" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "twoFactorStrictness" TEXT NOT NULL DEFAULT 'unusual';
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "signInCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SessionState" ADD COLUMN IF NOT EXISTS "stepUp" TEXT;
