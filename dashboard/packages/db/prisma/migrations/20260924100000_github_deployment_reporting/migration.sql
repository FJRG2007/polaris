-- The GitHub Deployment a release was announced as.
--
-- A deploy from a GitHub repository is something the repository has a place to
-- show: the deployment box on the commit and the pull request, where Vercel and
-- Railway put a state and a "View deployment" link. Polaris never wrote to it, so
-- a service could be building, live, or broken and the repository said nothing.
--
-- Announcing is a conversation rather than a single call - GitHub mints a
-- deployment, and every state after that is posted against it - so the id it
-- minted has to be kept somewhere. That is these two columns: the repository it
-- was minted on, and the id.
--
-- Both null on everything that already exists, and on anything that is not
-- deployed from GitHub or that nothing here has permission to write to. A null
-- pair reads as "never announced", which is exactly what those deploys are.

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "githubRepo" TEXT,
ADD COLUMN     "githubDeploymentId" TEXT;
