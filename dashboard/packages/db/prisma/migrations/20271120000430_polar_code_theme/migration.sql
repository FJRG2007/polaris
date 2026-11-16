-- The colors Polar Code paints code and diffs in (apps/web/src/lib/polar/code-theme.ts).
-- Null is the design system's own palette.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "codeTheme" TEXT;
