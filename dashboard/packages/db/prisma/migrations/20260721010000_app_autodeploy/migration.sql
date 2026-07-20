-- Auto-deploy on git push settings for applications.
ALTER TABLE "Application" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "deployBranch" TEXT;
ALTER TABLE "Application" ADD COLUMN "commitFilter" TEXT;
ALTER TABLE "Application" ADD COLUMN "lastDeployedSha" TEXT;
