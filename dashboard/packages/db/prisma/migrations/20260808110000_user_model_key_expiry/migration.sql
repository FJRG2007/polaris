-- Keys that expire, keys that cannot be stored twice, and names that mean one
-- thing across an account.
--
-- A name unique only within a provider still leaves two rows answering to
-- "prod-main", which is how a person refers to one of them out loud. The
-- fingerprint is the only way to notice the same secret being added twice: the
-- envelope uses a fresh nonce each time, so two rows holding one credential have
-- nothing in common to compare. And an expiry is something the provider will not
-- tell us, so it is what its owner entered when they set one on their side.
ALTER TABLE "UserModelKey" ADD COLUMN "secretFingerprint" TEXT;
ALTER TABLE "UserModelKey" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "UserModelKey" ADD COLUMN "expiryNotice" TEXT NOT NULL DEFAULT '';

-- Names were only unique per provider until now, so one account could hold two
-- rows called the same thing. Later ones take a suffix. Truncated to keep the
-- 20-character rule; if two truncations were to collide the unique index below
-- refuses and this migration stops, which is the visible failure to want.
UPDATE "UserModelKey" AS target
SET "name" = LEFT(LEFT(target."name", 18) || '-' || ordered."rank", 20)
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "name" ORDER BY "priority", "createdAt") AS "rank"
    FROM "UserModelKey"
) AS ordered
WHERE target."id" = ordered."id" AND ordered."rank" > 1;

DROP INDEX "UserModelKey_userId_provider_name_key";

CREATE UNIQUE INDEX "UserModelKey_userId_name_key" ON "UserModelKey"("userId", "name");

-- Rows written before the fingerprint existed carry null, and Postgres counts
-- nulls as distinct, so they neither collide with each other nor block a new
-- key. They gain one the next time their secret is written.
CREATE UNIQUE INDEX "UserModelKey_userId_provider_secretFingerprint_key"
    ON "UserModelKey"("userId", "provider", "secretFingerprint");

CREATE INDEX "UserModelKey_expiresAt_idx" ON "UserModelKey"("expiresAt");
