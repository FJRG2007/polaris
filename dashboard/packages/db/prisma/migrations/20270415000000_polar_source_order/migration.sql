-- The order a person lists providers and sources in, in the model picker.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "sourceOrder" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
