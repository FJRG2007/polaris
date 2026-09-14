-- A client asking to be let into a vault by a browser that is already in it.
-- Short-lived rows: deleted when spent, swept when they expire.
--
-- Every statement is written so that running it a second time is a no-op. Postgres
-- does not roll a migration back statement by statement, so one that fails halfway
-- leaves what came before it applied and the history marked failed - and the
-- deployment then re-runs this file from the top.
CREATE TABLE IF NOT EXISTS "VaultAuthorization" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "wrappedKey" TEXT,
    "status" TEXT NOT NULL,
    "userId" UUID,
    "deviceIdentifier" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "deviceType" INTEGER NOT NULL,
    "requestIp" TEXT,
    "requestUserAgent" TEXT,
    "requestHost" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VaultAuthorization_codeHash_key" ON "VaultAuthorization"("codeHash");

CREATE UNIQUE INDEX IF NOT EXISTS "VaultAuthorization_userCode_key" ON "VaultAuthorization"("userCode");

CREATE INDEX IF NOT EXISTS "VaultAuthorization_userId_idx" ON "VaultAuthorization"("userId");

CREATE INDEX IF NOT EXISTS "VaultAuthorization_expiresAt_idx" ON "VaultAuthorization"("expiresAt");
