-- Passkeys that unlock a vault through the WebAuthn PRF extension. Additive
-- only: a new table, nothing existing changes, and a vault without a row here
-- opens with its master password exactly as before.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "VaultPasskey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "rpId" TEXT NOT NULL,
    "prfSalt" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "VaultPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VaultPasskey_userId_idx" ON "VaultPasskey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VaultPasskey_userId_credentialId_key" ON "VaultPasskey"("userId", "credentialId");

-- AddForeignKey
ALTER TABLE "VaultPasskey" DROP CONSTRAINT IF EXISTS "VaultPasskey_userId_fkey";
ALTER TABLE "VaultPasskey" ADD CONSTRAINT "VaultPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
