-- Provider credentials somebody brought themselves.
--
-- Model keys were instance-wide only, so every run on the deployment spent one
-- account's money and only an administrator could choose a provider. These sit
-- in front of the instance's own, which stay as the fallback for anybody who has
-- not brought one - unless an administrator turns that off.
CREATE TABLE "UserModelKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserModelKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserModelKey_userId_provider_key" ON "UserModelKey"("userId", "provider");
CREATE INDEX "UserModelKey_userId_idx" ON "UserModelKey"("userId");

ALTER TABLE "UserModelKey" ADD CONSTRAINT "UserModelKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
