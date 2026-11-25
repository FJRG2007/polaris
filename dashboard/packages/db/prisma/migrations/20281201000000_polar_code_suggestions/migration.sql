-- Whether a Polar Code session suggests the next message after each turn
-- (apps/web/src/lib/polar/code-suggestion.ts). On until the person turns it off.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "codeSuggestions" BOOLEAN NOT NULL DEFAULT true;
