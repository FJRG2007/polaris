-- Branch environments and pull request previews.
--
-- An environment can follow one branch for every service in it that builds
-- from a repository, and an environment made for a pull request records which
-- one, where it came from and what it last deployed, so it can be kept current
-- while the pull request is open and removed when it closes.
--
-- All null on every existing environment, which keeps what they have always
-- meant: each service builds from its own branch.
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "branch" TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "pullRequest" INTEGER;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "previewRepo" TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "previewOfId" UUID;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "previewSha" TEXT;
