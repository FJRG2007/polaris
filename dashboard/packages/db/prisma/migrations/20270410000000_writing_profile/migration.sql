-- "Improve" picks its own model, and follows the writer's context, their
-- chosen skills and their organization's shared writing guide. Additive.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "improveModel" JSONB;
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "writingContext" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "writingSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "writingGuide" TEXT NOT NULL DEFAULT '';
