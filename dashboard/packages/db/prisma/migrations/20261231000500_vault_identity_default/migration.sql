-- The identity each person fills sign-up forms with, one per vault. Additive
-- only.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "VaultIdentityDefault" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "vaultOrganizationId" UUID,
    "cipherId" UUID NOT NULL,

    CONSTRAINT "VaultIdentityDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VaultIdentityDefault_vaultOrganizationId_idx" ON "VaultIdentityDefault"("vaultOrganizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VaultIdentityDefault_cipherId_idx" ON "VaultIdentityDefault"("cipherId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VaultIdentityDefault_userId_vaultOrganizationId_key" ON "VaultIdentityDefault"("userId", "vaultOrganizationId");

-- Postgres counts two nulls as different, so the index above lets one person
-- hold any number of personal defaults. This one keeps it to one.
CREATE UNIQUE INDEX IF NOT EXISTS "VaultIdentityDefault_personal_key" ON "VaultIdentityDefault"("userId") WHERE "vaultOrganizationId" IS NULL;

-- AddForeignKey
ALTER TABLE "VaultIdentityDefault" DROP CONSTRAINT IF EXISTS "VaultIdentityDefault_userId_fkey";
ALTER TABLE "VaultIdentityDefault" ADD CONSTRAINT "VaultIdentityDefault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultIdentityDefault" DROP CONSTRAINT IF EXISTS "VaultIdentityDefault_vaultOrganizationId_fkey";
ALTER TABLE "VaultIdentityDefault" ADD CONSTRAINT "VaultIdentityDefault_vaultOrganizationId_fkey" FOREIGN KEY ("vaultOrganizationId") REFERENCES "VaultOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultIdentityDefault" DROP CONSTRAINT IF EXISTS "VaultIdentityDefault_cipherId_fkey";
ALTER TABLE "VaultIdentityDefault" ADD CONSTRAINT "VaultIdentityDefault_cipherId_fkey" FOREIGN KEY ("cipherId") REFERENCES "VaultCipher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
