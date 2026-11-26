-- Quorum recovery of the account key, and the organisation recovery key.
--
-- Additive only: five new tables, nothing existing is altered. Every share is
-- an envelope sealed in a browser to another account's key; the server holds
-- none it can open. Dropping the tables reverses it.

CREATE TABLE IF NOT EXISTS "ChatRecoveryShare" (
    "ownerId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "akVersion" INTEGER NOT NULL,
    "splitId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "custodianAkVersion" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "envelope" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryShare_pkey" PRIMARY KEY ("ownerId", "custodianId")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryShare_custodianId_idx" ON "ChatRecoveryShare"("custodianId");

CREATE TABLE IF NOT EXISTS "ChatRecoveryRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountRecoveryId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "akVersion" INTEGER NOT NULL,
    "splitId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "requesterKey" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryRequest_userId_status_idx" ON "ChatRecoveryRequest"("userId", "status");
CREATE INDEX IF NOT EXISTS "ChatRecoveryRequest_status_expiresAt_idx" ON "ChatRecoveryRequest"("status", "expiresAt");

CREATE TABLE IF NOT EXISTS "ChatRecoveryApproval" (
    "requestId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "envelope" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryApproval_pkey" PRIMARY KEY ("requestId", "custodianId")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryApproval_custodianId_idx" ON "ChatRecoveryApproval"("custodianId");

CREATE TABLE IF NOT EXISTS "ChatRecoveryKey" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "hpkePublicKey" BYTEA NOT NULL,
    "threshold" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryKey_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryKey_scope_retiredAt_idx" ON "ChatRecoveryKey"("scope", "retiredAt");

CREATE TABLE IF NOT EXISTS "ChatRecoveryKeyShare" (
    "keyId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "custodianAkVersion" INTEGER NOT NULL,
    "envelope" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecoveryKeyShare_pkey" PRIMARY KEY ("keyId", "custodianId")
);
CREATE INDEX IF NOT EXISTS "ChatRecoveryKeyShare_custodianId_idx" ON "ChatRecoveryKeyShare"("custodianId");

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryShare" ADD CONSTRAINT "ChatRecoveryShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryShare" ADD CONSTRAINT "ChatRecoveryShare_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryRequest" ADD CONSTRAINT "ChatRecoveryRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryApproval" ADD CONSTRAINT "ChatRecoveryApproval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ChatRecoveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatRecoveryKeyShare" ADD CONSTRAINT "ChatRecoveryKeyShare_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ChatRecoveryKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
