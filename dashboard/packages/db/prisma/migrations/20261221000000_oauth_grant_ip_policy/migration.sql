-- Where a connected app may call from.
--
-- The address the person approved it from, the rule they set on the
-- connection, and the last call that rule refused. Null on every grant that
-- already exists, which reads as "from anywhere" - exactly what those grants
-- allowed before.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "approvedIp" TEXT;
ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "ipPolicy" TEXT;
ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "lastRefusedAt" TIMESTAMP(3);
ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "lastRefusedIp" TEXT;
