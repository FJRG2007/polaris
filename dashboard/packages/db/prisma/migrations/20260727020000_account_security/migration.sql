-- Account security: two-factor authentication, per-user security preferences,
-- recovery questions, reusable network access groups, personal API keys, and
-- Polaris-owned per-session state (sign-in approval + idle lock).

-- better-auth two-factor plugin storage. The secret arrives already encrypted
-- under POLARIS_AUTH_SECRET; neither column is ever returned to a client.
ALTER TABLE "User" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TwoFactor" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "TwoFactor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TwoFactor_userId_idx" ON "TwoFactor"("userId");
CREATE INDEX "TwoFactor_secret_idx" ON "TwoFactor"("secret");
ALTER TABLE "TwoFactor" ADD CONSTRAINT "TwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user security preferences. Absent row means every default applies.
CREATE TABLE "UserSecurity" (
    "userId" UUID NOT NULL,
    "pinHash" TEXT,
    "pinUpdatedAt" TIMESTAMP(3),
    "idleLockMinutes" INTEGER NOT NULL DEFAULT 0,
    "sessionMaxMinutes" INTEGER NOT NULL DEFAULT 0,
    "requireLoginApproval" BOOLEAN NOT NULL DEFAULT false,
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSecurity_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserSecurity" ADD CONSTRAINT "UserSecurity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Knowledge-based recovery factor; answers are stored hashed.
CREATE TABLE "SecurityQuestion" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answerHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityQuestion_userId_idx" ON "SecurityQuestion"("userId");
ALTER TABLE "SecurityQuestion" ADD CONSTRAINT "SecurityQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reusable named network rules, attachable to sign-ins and to API keys.
CREATE TABLE "AccessGroup" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessGroup_ownerId_name_key" ON "AccessGroup"("ownerId", "name");
CREATE INDEX "AccessGroup_ownerId_idx" ON "AccessGroup"("ownerId");
ALTER TABLE "AccessGroup" ADD CONSTRAINT "AccessGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserAccessGroup" (
    "userId" UUID NOT NULL,
    "groupId" UUID NOT NULL,

    CONSTRAINT "UserAccessGroup_pkey" PRIMARY KEY ("userId", "groupId")
);

CREATE INDEX "UserAccessGroup_groupId_idx" ON "UserAccessGroup"("groupId");
ALTER TABLE "UserAccessGroup" ADD CONSTRAINT "UserAccessGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAccessGroup" ADD CONSTRAINT "UserAccessGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccessGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Personal access tokens. Only the SHA-256 of the issued secret is stored.
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApiKeyAccessGroup" (
    "apiKeyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,

    CONSTRAINT "ApiKeyAccessGroup_pkey" PRIMARY KEY ("apiKeyId", "groupId")
);

CREATE INDEX "ApiKeyAccessGroup_groupId_idx" ON "ApiKeyAccessGroup"("groupId");
ALTER TABLE "ApiKeyAccessGroup" ADD CONSTRAINT "ApiKeyAccessGroup_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyAccessGroup" ADD CONSTRAINT "ApiKeyAccessGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccessGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Polaris-owned per-session state. Existing sessions predate the feature, so
-- they are seeded as approved and last seen now: enabling login approval must
-- not lock out the session the user is enabling it from.
CREATE TABLE "SessionState" (
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "approval" TEXT NOT NULL DEFAULT 'approved',
    "lockedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionState_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "SessionState_userId_idx" ON "SessionState"("userId");
ALTER TABLE "SessionState" ADD CONSTRAINT "SessionState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionState" ADD CONSTRAINT "SessionState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SessionState" ("sessionId", "userId", "approval", "ip", "userAgent")
SELECT "id", "userId", 'approved', "ipAddress", "userAgent" FROM "Session";
