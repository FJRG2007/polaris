-- Getting back into an account from outside it. A request is raised by whoever
-- has lost their password, optionally backed by the recovery questions, and an
-- administrator decides it. Only the SHA-256 of the requester's ticket is kept.

CREATE TABLE "AccountRecovery" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestIp" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountRecovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountRecovery_tokenHash_key" ON "AccountRecovery"("tokenHash");
CREATE INDEX "AccountRecovery_userId_idx" ON "AccountRecovery"("userId");
CREATE INDEX "AccountRecovery_status_createdAt_idx" ON "AccountRecovery"("status", "createdAt");
ALTER TABLE "AccountRecovery" ADD CONSTRAINT "AccountRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
