-- An organization becomes a place you work from, rather than a roster you belong to.
--
-- Four things arrive together because they are one change seen from four sides:
-- an organization defines its own roles, has a photo, keeps a history of what was
-- done to it, and can own the projects and the domains that work is deployed on.
--
-- Everything existing stays personal. Every new column is nullable or defaulted,
-- and the two role slugs seeded below are precisely the values OrganizationMember
-- rows already hold, so a roster written before this migration keeps meaning what
-- it meant.

-- The organization's own roles. Slug rather than id on the membership, so
-- renaming a role leaves the roster alone.
CREATE TABLE "OrgRole" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgRole_orgId_slug_key" ON "OrgRole"("orgId", "slug");
CREATE INDEX "OrgRole_orgId_idx" ON "OrgRole"("orgId");

ALTER TABLE "OrgRole" ADD CONSTRAINT "OrgRole_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the two roles every organization that already exists has been using by
-- name. Without this an existing roster would name roles no table has, and the
-- first read would have to invent them.
INSERT INTO "OrgRole" ("id", "orgId", "slug", "name", "description", "permissions", "system", "updatedAt")
SELECT gen_random_uuid(), "id", 'admin', 'Admin',
       'Runs the roster, the teams, the work and the settings.', '["*"]', true, CURRENT_TIMESTAMP
FROM "Organization";

INSERT INTO "OrgRole" ("id", "orgId", "slug", "name", "description", "permissions", "system", "updatedAt")
SELECT gen_random_uuid(), "id", 'member', 'Member',
       'Sees the organization and reaches whatever their teams reach.', '["org.read"]', true, CURRENT_TIMESTAMP
FROM "Organization";

-- The organization's photo, stored the way an account's is.
CREATE TABLE "OrganizationAvatar" (
    "orgId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAvatar_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "OrganizationAvatar" ADD CONSTRAINT "OrganizationAvatar_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A domain somebody brought themselves. Exactly one owner column is set; no
-- constraint enforces that here because the service is the only writer and says
-- so in one place, and a CHECK would refuse rows a later owner kind needs.
CREATE TABLE "OwnerDomain" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "orgId" UUID,
    "domain" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "wildcardOk" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3),
    "checkDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerDomain_pkey" PRIMARY KEY ("id")
);

-- One claim per name across the instance: two owners cannot both be issued
-- certificates for the same hostname.
CREATE UNIQUE INDEX "OwnerDomain_domain_key" ON "OwnerDomain"("domain");
CREATE INDEX "OwnerDomain_userId_idx" ON "OwnerDomain"("userId");
CREATE INDEX "OwnerDomain_orgId_idx" ON "OwnerDomain"("orgId");

ALTER TABLE "OwnerDomain" ADD CONSTRAINT "OwnerDomain_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerDomain" ADD CONSTRAINT "OwnerDomain_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which shelf a project sits on. Null on every existing row, which is what keeps
-- them personal.
ALTER TABLE "Project" ADD COLUMN "orgId" UUID;

CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What an entry was about, when it was about an organization. Deliberately not a
-- foreign key: deleting an organization must not erase the record of it.
ALTER TABLE "AuditLog" ADD COLUMN "orgId" UUID;

CREATE INDEX "AuditLog_orgId_idx" ON "AuditLog"("orgId");
