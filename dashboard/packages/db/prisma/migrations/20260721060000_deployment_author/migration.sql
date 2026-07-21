-- Commit author (GitHub) for the deployment avatar, resolved at deploy time.
ALTER TABLE "Deployment" ADD COLUMN "authorName" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "authorAvatarUrl" TEXT;
