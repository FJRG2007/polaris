-- What an organization's role is held to in its CRM per kind of record: own
-- records only, hidden fields, read-only fields. Additive; to reverse, drop
-- CrmRoleRule.

CREATE TABLE IF NOT EXISTS "CrmRoleRule" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "rows" TEXT NOT NULL DEFAULT 'all',
    "hidden" TEXT NOT NULL DEFAULT '[]',
    "readOnly" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmRoleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmRoleRule_orgId_role_object_key" ON "CrmRoleRule"("orgId", "role", "object");

-- AddForeignKey
ALTER TABLE "CrmRoleRule" DROP CONSTRAINT IF EXISTS "CrmRoleRule_orgId_fkey";
ALTER TABLE "CrmRoleRule" ADD CONSTRAINT "CrmRoleRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
