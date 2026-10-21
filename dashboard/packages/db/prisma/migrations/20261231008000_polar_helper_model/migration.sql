-- Polar's small jobs: whether a suggested next message follows each answer,
-- and the model that writes titles and suggestions (null is Automatic).
-- Columns with defaults only; an existing row reads as suggestions on and
-- Automatic, the same as no row at all.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "suggestions" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "helperModel" JSONB;
