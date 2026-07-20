-- Keep previous deployments running (Railway-style), off by default.
ALTER TABLE "Application" ADD COLUMN "keepReleases" BOOLEAN NOT NULL DEFAULT false;
