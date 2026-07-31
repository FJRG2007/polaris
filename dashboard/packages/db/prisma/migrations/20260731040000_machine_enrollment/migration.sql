-- An offer to let one machine join Polaris, redeemed by a script run on it.
-- Polaris mints the SSH key pair up front and keeps the private half here
-- (envelope-encrypted, same as every other stored credential); the script
-- installs only the public half. Nothing secret travels to the machine and
-- nothing secret comes back, so an intercepted command yields only a token that
-- expires in minutes and works once.
CREATE TABLE "Enrollment" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'server',
    "tokenHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "username" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedKey" BYTEA NOT NULL,
    "keyNonce" BYTEA NOT NULL,
    "keyKeyId" TEXT NOT NULL,
    -- Public host keys the machine reported while the script still had root.
    -- Polaris pins against these on its first connect, closing the window that
    -- trust-on-add leaves open.
    "hostKeys" TEXT NOT NULL DEFAULT '',
    "address" TEXT,
    "port" INTEGER NOT NULL DEFAULT 22,
    "claimedAt" TIMESTAMP(3),
    "hostId" UUID,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Enrollment_tokenHash_key" ON "Enrollment"("tokenHash");
CREATE INDEX "Enrollment_createdById_idx" ON "Enrollment"("createdById");
CREATE INDEX "Enrollment_expiresAt_idx" ON "Enrollment"("expiresAt");

ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The enrollment outlives the Host it created: removing a server should not
-- erase the record of how it got here, only the pointer.
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;
