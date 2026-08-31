-- Project access stops being a rank and becomes a set.
--
-- An entry may now be for a team, an organization, or everyone with an account
-- rather than one person; it carries the capabilities it grants written out in
-- full; it may be limited to some of the project's environments; and it may
-- expire. The role column stays for display, and existing rows are expanded into
-- the capability set their role has always meant, so nobody's access changes.

-- AlterTable
ALTER TABLE "ProjectMember" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "ProjectMember" ADD COLUMN     "teamId" UUID,
ADD COLUMN     "orgId" UUID,
ADD COLUMN     "capabilities" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "environments" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: the capabilities each role has always carried, in catalogue order.
UPDATE "ProjectMember" SET "capabilities" = '["project.read","logs.read"]' WHERE "role" = 'viewer';
UPDATE "ProjectMember" SET "capabilities" = '["project.read","logs.read","deploy.run","service.configure","service.create","variables.read","variables.write","console.use","files.read","files.write","domains.manage","volumes.manage","databases.manage"]' WHERE "role" = 'developer';
UPDATE "ProjectMember" SET "capabilities" = '["project.read","logs.read","deploy.run","service.configure","service.create","service.delete","variables.read","variables.write","console.use","files.read","files.write","domains.manage","volumes.manage","databases.manage","project.settings","members.manage"]' WHERE "role" = 'admin';

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_teamId_key" ON "ProjectMember"("projectId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_orgId_key" ON "ProjectMember"("projectId", "orgId");

-- CreateIndex
CREATE INDEX "ProjectMember_teamId_idx" ON "ProjectMember"("teamId");

-- CreateIndex
CREATE INDEX "ProjectMember_orgId_idx" ON "ProjectMember"("orgId");

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
