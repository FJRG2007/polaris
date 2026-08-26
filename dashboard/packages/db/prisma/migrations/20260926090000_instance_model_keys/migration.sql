-- The deployment's own provider keys become keys like everybody else's.
--
-- They used to live on the Integration row for the provider: one key each, no
-- name, no end date, no order, and a screen that asked about them as though
-- connecting Anthropic were the same job as connecting a storage vendor. There
-- was never a reason for an administrator's keys to be the poor relation of the
-- ones an account brings itself - the same list, the same fallback order and the
-- same expiry warnings apply either way - so they are now the same rows, told
-- apart only by having no owner.
--
-- A null `userId` is the deployment's. Postgres counts two nulls as distinct, so
-- the ordinary unique indexes cover an account's rows and say nothing about the
-- instance's; the partial indexes below are what keep the deployment from
-- holding one name, or one credential, twice.
--
-- Everything already stored is carried over: the envelope columns are the same
-- shape in both tables (the same master key, the same AES-256-GCM blob), so this
-- is a column copy and no key is decrypted here. A migrated key is named after
-- its provider, which is the only name it ever had. The one thing left behind is
-- a gateway that was configured and then switched off: the new screen has no
-- "off" - a key that is there is a key runs may spend - and turning one back on
-- silently is not a thing a migration should do.

-- AlterTable
ALTER TABLE "UserModelKey" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UserModelKey_instance_name_key" ON "UserModelKey"("name") WHERE "userId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UserModelKey_instance_provider_fingerprint_key" ON "UserModelKey"("provider", "secretFingerprint") WHERE "userId" IS NULL;

-- The provider keys, in slug order so the list a deployment opens on is stable.
INSERT INTO "UserModelKey" (
    "id", "userId", "provider", "name", "priority",
    "encryptedSecret", "secretNonce", "secretKeyId",
    "config", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid(),
    NULL,
    "provider",
    "provider",
    (ROW_NUMBER() OVER (ORDER BY "provider")) - 1,
    "encryptedSecret",
    "secretNonce",
    COALESCE("secretKeyId", ''),
    '{}',
    "createdAt",
    "updatedAt"
FROM "Integration"
WHERE "provider" IN (
    'anthropic', 'openai', 'google-ai', 'xai', 'deepseek',
    'moonshot', 'groq', 'cerebras', 'openrouter'
)
  AND "encryptedSecret" IS NOT NULL;

-- The gateway, which is not a provider: it carries an endpoint rather than a
-- key, and frequently no key at all. An empty envelope is how such a row says it
-- holds no credential - the only rows that have one are these.
INSERT INTO "UserModelKey" (
    "id", "userId", "provider", "name", "priority",
    "encryptedSecret", "secretNonce", "secretKeyId",
    "config", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid(),
    NULL,
    "provider",
    "provider",
    (SELECT COUNT(*) FROM "UserModelKey" WHERE "userId" IS NULL),
    COALESCE("encryptedSecret", ''::bytea),
    COALESCE("secretNonce", ''::bytea),
    COALESCE("secretKeyId", ''),
    "config",
    "createdAt",
    "updatedAt"
FROM "Integration"
WHERE "provider" = 'enigma'
  AND "enabled" = true
  AND "config" LIKE '%"baseUrl":"http%';

-- What was copied is gone from the marketplace: a credential no screen can reach
-- any more is one nobody can rotate or remove.
DELETE FROM "Integration"
WHERE "provider" IN (
    'anthropic', 'openai', 'google-ai', 'xai', 'deepseek',
    'moonshot', 'groq', 'cerebras', 'openrouter', 'enigma'
);
