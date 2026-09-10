-- Backups sealed at rest: each copy names the backup key it was sealed under,
-- and each owner has a ring of those keys, wrapped under the master key.
ALTER TABLE "RecoveryPointCopy" ADD COLUMN IF NOT EXISTS "sealedWith" TEXT;

CREATE TABLE IF NOT EXISTS "BackupKey" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "encryptedKey" BYTEA NOT NULL,
    "keyNonce" BYTEA NOT NULL,
    "keyKeyId" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BackupKey_ownerId_retiredAt_idx" ON "BackupKey"("ownerId", "retiredAt");

ALTER TABLE "BackupKey" DROP CONSTRAINT IF EXISTS "BackupKey_ownerId_fkey";
ALTER TABLE "BackupKey" ADD CONSTRAINT "BackupKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
