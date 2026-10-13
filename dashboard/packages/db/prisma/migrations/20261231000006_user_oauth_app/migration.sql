-- A provider application somebody registered themselves, for their own links.
-- Nobody has one until they add it, so this changes nothing for anybody.
-- Additive; to reverse, drop the table.
CREATE TABLE IF NOT EXISTS "UserOAuthApp" (
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserOAuthApp_pkey" PRIMARY KEY ("userId", "provider")
);

ALTER TABLE "UserOAuthApp" DROP CONSTRAINT IF EXISTS "UserOAuthApp_userId_fkey";
ALTER TABLE "UserOAuthApp" ADD CONSTRAINT "UserOAuthApp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
