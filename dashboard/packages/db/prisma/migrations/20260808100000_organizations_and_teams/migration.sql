-- Organizations, teams, and the grants a team carries.
--
-- Work was only ever owned by a person, so a space died with the account that
-- made it and a group of people had to be re-added one at a time to everything.
-- An organization owns spaces on the group's behalf and a team is the unit those
-- spaces are granted to, so somebody joining a team reaches the work at once and
-- somebody leaving it stops reaching all of it.
--
-- Existing spaces have no organization, which is what makes them personal and
-- leaves every current access rule answering exactly as it did before.
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image" TEXT,
    "ownerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_ownerId_idx" ON "Organization"("ownerId");

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganizationMember" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationMember_orgId_userId_key" ON "OrganizationMember"("orgId", "userId");
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Team_orgId_slug_key" ON "Team"("orgId", "slug");
CREATE INDEX "Team_orgId_idx" ON "Team"("orgId");

ALTER TABLE "Team" ADD CONSTRAINT "Team_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TeamMember" (
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId", "userId")
);

CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TaskSpaceTeam" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSpaceTeam_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskSpaceTeam_spaceId_teamId_key" ON "TaskSpaceTeam"("spaceId", "teamId");
CREATE INDEX "TaskSpaceTeam_teamId_idx" ON "TaskSpaceTeam"("teamId");

ALTER TABLE "TaskSpaceTeam" ADD CONSTRAINT "TaskSpaceTeam_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskSpaceTeam" ADD CONSTRAINT "TaskSpaceTeam_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TaskFolderTeam" (
    "id" UUID NOT NULL,
    "folderId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFolderTeam_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskFolderTeam_folderId_teamId_key" ON "TaskFolderTeam"("folderId", "teamId");
CREATE INDEX "TaskFolderTeam_teamId_idx" ON "TaskFolderTeam"("teamId");

ALTER TABLE "TaskFolderTeam" ADD CONSTRAINT "TaskFolderTeam_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskFolderTeam" ADD CONSTRAINT "TaskFolderTeam_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Null on every existing row, which is what keeps them personal.
ALTER TABLE "TaskSpace" ADD COLUMN "orgId" UUID;

CREATE INDEX "TaskSpace_orgId_idx" ON "TaskSpace"("orgId");

ALTER TABLE "TaskSpace" ADD CONSTRAINT "TaskSpace_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
