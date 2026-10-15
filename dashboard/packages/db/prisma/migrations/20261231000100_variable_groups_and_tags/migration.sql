-- Variable groups shared across Deploy projects, and tags on projects and
-- services. Two new tables and two new columns with defaults; nothing existing
-- changes. A group's variables are EnvVar rows with scopeType 'group', which
-- needs no schema change. To reverse: drop both tables and both columns.

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "tags" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "tags" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS "VariableGroup" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VariableGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VariableGroup_ownerId_idx" ON "VariableGroup"("ownerId");
CREATE INDEX IF NOT EXISTS "VariableGroup_orgId_idx" ON "VariableGroup"("orgId");

CREATE TABLE IF NOT EXISTS "VariableGroupLink" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariableGroupLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VariableGroupLink_groupId_applicationId_key" ON "VariableGroupLink"("groupId", "applicationId");
CREATE INDEX IF NOT EXISTS "VariableGroupLink_applicationId_idx" ON "VariableGroupLink"("applicationId");

ALTER TABLE "VariableGroupLink" DROP CONSTRAINT IF EXISTS "VariableGroupLink_groupId_fkey";
ALTER TABLE "VariableGroupLink" ADD CONSTRAINT "VariableGroupLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VariableGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VariableGroupLink" DROP CONSTRAINT IF EXISTS "VariableGroupLink_applicationId_fkey";
ALTER TABLE "VariableGroupLink" ADD CONSTRAINT "VariableGroupLink_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
