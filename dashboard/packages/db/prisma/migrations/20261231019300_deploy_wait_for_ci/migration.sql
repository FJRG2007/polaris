-- "Wait for CI" on a service: additive. Every existing service keeps deploying a
-- push as soon as it lands, and nothing is waiting until somebody turns it on.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "waitForCi" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "DeployCiWait" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL DEFAULT '',
    "authorName" TEXT,
    "authorAvatarUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "failedCheck" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeployCiWait_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeployCiWait_applicationId_key" ON "DeployCiWait"("applicationId");
CREATE INDEX IF NOT EXISTS "DeployCiWait_status_checkedAt_idx" ON "DeployCiWait"("status", "checkedAt");
CREATE INDEX IF NOT EXISTS "DeployCiWait_repoFullName_commitSha_idx" ON "DeployCiWait"("repoFullName", "commitSha");
ALTER TABLE "DeployCiWait" DROP CONSTRAINT IF EXISTS "DeployCiWait_applicationId_fkey";
ALTER TABLE "DeployCiWait" ADD CONSTRAINT "DeployCiWait_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
