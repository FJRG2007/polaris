-- How Polar Code shows the agent's steps (apps/web/src/lib/polar/code-steps.ts):
-- compact (a line each) or detailed (cards open). Null is not chosen yet.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "codeSteps" TEXT;
