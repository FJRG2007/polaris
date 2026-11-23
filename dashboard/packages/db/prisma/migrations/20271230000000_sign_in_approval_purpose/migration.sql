-- What a phone sign-in approval is for: "second-factor" (finishing a challenge
-- the browser already holds) or "sign-in" (no password: the approval is the sign-in).
-- Additive and rerunnable; every existing row is a second-factor request.
ALTER TABLE "SignInApproval" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'second-factor';
