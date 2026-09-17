-- A browser extension authorized to act for an account, and the short-lived
-- request it is let in by. The vault client an extension lets in remembers which
-- connection did it, so ending the connection ends that too.
--
-- Written so that running it a second time is a no-op.

CREATE TABLE IF NOT EXISTS "ExtensionSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "browser" TEXT,
    "os" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "host" TEXT,
    "tokenHash" TEXT NOT NULL,
    "approvedBySessionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExtensionSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExtensionAuthorization" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "requestIp" TEXT,
    "requestUserAgent" TEXT,
    "requestHost" TEXT,
    "status" TEXT NOT NULL,
    "userId" UUID,
    "approvedBySessionId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionSession_tokenHash_key" ON "ExtensionSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "ExtensionSession_userId_idx" ON "ExtensionSession"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionSession_userId_deviceId_key" ON "ExtensionSession"("userId", "deviceId");
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionAuthorization_codeHash_key" ON "ExtensionAuthorization"("codeHash");
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionAuthorization_userCode_key" ON "ExtensionAuthorization"("userCode");
CREATE INDEX IF NOT EXISTS "ExtensionAuthorization_expiresAt_idx" ON "ExtensionAuthorization"("expiresAt");

ALTER TABLE "ExtensionSession" DROP CONSTRAINT IF EXISTS "ExtensionSession_userId_fkey";
ALTER TABLE "ExtensionSession" ADD CONSTRAINT "ExtensionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VaultDevice" ADD COLUMN IF NOT EXISTS "extensionSessionId" UUID;
CREATE INDEX IF NOT EXISTS "VaultDevice_extensionSessionId_idx" ON "VaultDevice"("extensionSessionId");
ALTER TABLE "VaultDevice" DROP CONSTRAINT IF EXISTS "VaultDevice_extensionSessionId_fkey";
ALTER TABLE "VaultDevice" ADD CONSTRAINT "VaultDevice_extensionSessionId_fkey" FOREIGN KEY ("extensionSessionId") REFERENCES "ExtensionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VaultAuthorization" ADD COLUMN IF NOT EXISTS "extensionSessionId" UUID;
