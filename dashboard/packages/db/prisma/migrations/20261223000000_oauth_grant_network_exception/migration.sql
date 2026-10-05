-- Where a connected app may call from even though the account's network rules
-- refuse the address: the per-connection exception for an assistant that calls
-- from its own servers. Null on every grant that already exists, which reads as
-- "no exception" - exactly how those grants were judged before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "networkException" TEXT;
