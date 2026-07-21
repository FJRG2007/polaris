-- Head commit message per deployment (for the Railway-style deployment history).
ALTER TABLE "Deployment" ADD COLUMN "commitMessage" TEXT;
