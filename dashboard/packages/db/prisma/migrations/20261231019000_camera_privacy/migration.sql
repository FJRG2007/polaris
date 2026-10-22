-- Camera privacy: additive columns, every existing camera stays not private.
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "privacy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "privacyChangedAt" TIMESTAMP(3);
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "privacyPreset" TEXT;
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "controlPin" TEXT;
