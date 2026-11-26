-- Opening an organisation recovery key with a quorum of its custodians.
--
-- Additive only: one nullable column on "ChatRecoveryKey" (null keeps meaning
-- "the split named by the key's id", what every existing row has) and two new
-- tables. Dropping the column and the tables reverses it.

ALTER TABLE "ChatRecoveryKey" ADD COLUMN IF NOT EXISTS "splitId" TEXT;

CREATE TABLE IF NOT EXISTS "ChatRecoveryKeyOpening" (
    "id" UUID NOT NULL,
    "keyId" UUID NOT NULL,
    "openerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "splitId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "requesterKey" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryKeyOpening_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryKeyOpening_keyId_status_idx" ON "ChatRecoveryKeyOpening"("keyId", "status");
CREATE INDEX IF NOT EXISTS "ChatRecoveryKeyOpening_openerId_status_idx" ON "ChatRecoveryKeyOpening"("openerId", "status");
CREATE INDEX IF NOT EXISTS "ChatRecoveryKeyOpening_status_expiresAt_idx" ON "ChatRecoveryKeyOpening"("status", "expiresAt");

CREATE TABLE IF NOT EXISTS "ChatRecoveryKeyRelease" (
    "openingId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    -- NULL: the custodian declined.
    "envelope" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryKeyRelease_pkey" PRIMARY KEY ("openingId", "custodianId")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryKeyRelease_custodianId_idx" ON "ChatRecoveryKeyRelease"("custodianId");

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryKeyOpening" ADD CONSTRAINT "ChatRecoveryKeyOpening_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ChatRecoveryKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryKeyRelease" ADD CONSTRAINT "ChatRecoveryKeyRelease_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "ChatRecoveryKeyOpening"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
