-- What a connected app asked for when it was approved.
--
-- The ceiling on changing its permissions afterwards: a person can tick more
-- boxes later, but never one the app did not ask for. Null on every grant that
-- already exists, which the app reads as "only what was approved", so an old
-- grant can be narrowed but not widened until the app is connected again.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "requestedScopes" TEXT;
