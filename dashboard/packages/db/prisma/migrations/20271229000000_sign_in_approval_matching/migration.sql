-- Number matching and attempt details on phone sign-in approvals. Additive and rerunnable.
ALTER TABLE "SignInApproval" ADD COLUMN IF NOT EXISTS "place" TEXT;
ALTER TABLE "SignInApproval" ADD COLUMN IF NOT EXISTS "matchNumber" INTEGER;
ALTER TABLE "SignInApproval" ADD COLUMN IF NOT EXISTS "reason" TEXT;
CREATE INDEX IF NOT EXISTS "SignInApproval_userId_reason_decidedAt_idx" ON "SignInApproval"("userId", "reason", "decidedAt");
