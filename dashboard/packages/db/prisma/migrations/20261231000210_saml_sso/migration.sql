-- SAML single sign-on. Additive: a new table, plus the verification id widened
-- from uuid to text so better-auth's one-time replay markers (hash ids) fit.
-- Every existing id is a uuid and casts to text unchanged; reversing it is
-- `ALTER COLUMN "id" TYPE UUID USING "id"::uuid` once those markers expire.
ALTER TABLE "Verification" ALTER COLUMN "id" TYPE TEXT USING "id"::text;

CREATE TABLE IF NOT EXISTS "SsoProvider" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "oidcConfig" TEXT,
    "samlConfig" TEXT,
    "userId" UUID,
    "providerId" TEXT NOT NULL,
    "organizationId" TEXT,
    "domain" TEXT NOT NULL,
    "domainVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT '',
    "allowSignUp" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "domainToken" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SsoProvider_providerId_key" ON "SsoProvider"("providerId");
