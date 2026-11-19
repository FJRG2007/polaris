-- Approving a sign-in from the phone app. Additive and rerunnable.
CREATE TABLE IF NOT EXISTS "SignInApproval" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "device" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "SignInApproval_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SignInApproval_userId_status_expiresAt_idx" ON "SignInApproval"("userId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "SignInApproval_challengeHash_idx" ON "SignInApproval"("challengeHash");
ALTER TABLE "SignInApproval" DROP CONSTRAINT IF EXISTS "SignInApproval_userId_fkey";
ALTER TABLE "SignInApproval" ADD CONSTRAINT "SignInApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
