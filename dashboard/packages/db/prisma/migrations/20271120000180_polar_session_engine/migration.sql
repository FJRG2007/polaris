-- The engine Polar Code sessions run on; null is Automatic.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "sessionEngine" TEXT;
