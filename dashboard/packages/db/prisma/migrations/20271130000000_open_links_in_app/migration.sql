-- Whether a Polaris link opens in the Polaris app. Rerunnable.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "openLinksInApp" BOOLEAN NOT NULL DEFAULT true;
