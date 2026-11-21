-- Chat end-to-end encryption, phase 1: the account key's public halves, the
-- envelopes that seal it under each lock, OPAQUE records and login states, and
-- the instance's sealed OPAQUE server setup. Nothing reads these until the
-- internal rollout flag is switched on.
--
-- Additive only: five new tables. Written to be safe to run twice.
CREATE TABLE IF NOT EXISTS "ChatAccountKey" (
    "userId" UUID NOT NULL,
    "akVersion" INTEGER NOT NULL,
    "signPublicKey" BYTEA NOT NULL,
    "hpkePublicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAccountKey_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "ChatAccountKey" DROP CONSTRAINT IF EXISTS "ChatAccountKey_userId_fkey";
ALTER TABLE "ChatAccountKey" ADD CONSTRAINT "ChatAccountKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatAccountKeyLock" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "lockId" TEXT NOT NULL,
    "akVersion" INTEGER NOT NULL,
    "envelope" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAccountKeyLock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatAccountKeyLock_userId_kind_lockId_key" ON "ChatAccountKeyLock"("userId", "kind", "lockId");
ALTER TABLE "ChatAccountKeyLock" DROP CONSTRAINT IF EXISTS "ChatAccountKeyLock_userId_fkey";
ALTER TABLE "ChatAccountKeyLock" ADD CONSTRAINT "ChatAccountKeyLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "OpaqueRecord" (
    "userId" UUID NOT NULL,
    "record" TEXT NOT NULL,
    "passwordTag" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpaqueRecord_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "OpaqueRecord" DROP CONSTRAINT IF EXISTS "OpaqueRecord_userId_fkey";
ALTER TABLE "OpaqueRecord" ADD CONSTRAINT "OpaqueRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "OpaqueLogin" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "purpose" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpaqueLogin_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OpaqueLogin_expiresAt_idx" ON "OpaqueLogin"("expiresAt");

CREATE TABLE IF NOT EXISTS "OpaqueServerSetup" (
    "id" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpaqueServerSetup_pkey" PRIMARY KEY ("id")
);
