-- What started a deployment: somebody pressing deploy, a push, a pull request
-- preview, a rollback, or a variable change applied to the running release.
-- Null on every deployment made before it was recorded.
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "trigger" TEXT;
