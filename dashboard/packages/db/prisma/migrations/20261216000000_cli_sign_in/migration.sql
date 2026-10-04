-- Signing in from the command line.
--
-- `ApiKey.kind` says what issued a key: "key" for every key that exists today
-- (the default backfills them), "cli" for the one `plr login` is handed. The
-- `CliAuthorization` row is the short-lived request that login opens and
-- somebody signed in approves.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'key';

CREATE TABLE IF NOT EXISTS "CliAuthorization" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "clientVersion" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "requestIp" TEXT,
    "requestUserAgent" TEXT,
    "requestHost" TEXT,
    "status" TEXT NOT NULL,
    "userId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CliAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CliAuthorization_codeHash_key" ON "CliAuthorization"("codeHash");
CREATE UNIQUE INDEX IF NOT EXISTS "CliAuthorization_userCode_key" ON "CliAuthorization"("userCode");
CREATE INDEX IF NOT EXISTS "CliAuthorization_expiresAt_idx" ON "CliAuthorization"("expiresAt");
