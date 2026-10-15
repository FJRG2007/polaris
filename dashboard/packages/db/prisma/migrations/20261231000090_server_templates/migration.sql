-- Server templates and their assignments to servers. New tables only; nothing
-- existing changes. To reverse, drop both tables.

CREATE TABLE IF NOT EXISTS "HostTemplate" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "spec" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HostTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HostTemplateAssignment" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "autoFix" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "drift" JSONB,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),
    "fixedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostTemplateAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HostTemplate_ownerId_idx" ON "HostTemplate"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "HostTemplate_ownerId_name_key" ON "HostTemplate"("ownerId", "name");
CREATE INDEX IF NOT EXISTS "HostTemplateAssignment_hostId_idx" ON "HostTemplateAssignment"("hostId");
CREATE INDEX IF NOT EXISTS "HostTemplateAssignment_checkedAt_idx" ON "HostTemplateAssignment"("checkedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "HostTemplateAssignment_templateId_hostId_key" ON "HostTemplateAssignment"("templateId", "hostId");

ALTER TABLE "HostTemplate" DROP CONSTRAINT IF EXISTS "HostTemplate_ownerId_fkey";
ALTER TABLE "HostTemplate" ADD CONSTRAINT "HostTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HostTemplateAssignment" DROP CONSTRAINT IF EXISTS "HostTemplateAssignment_templateId_fkey";
ALTER TABLE "HostTemplateAssignment" ADD CONSTRAINT "HostTemplateAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "HostTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HostTemplateAssignment" DROP CONSTRAINT IF EXISTS "HostTemplateAssignment_hostId_fkey";
ALTER TABLE "HostTemplateAssignment" ADD CONSTRAINT "HostTemplateAssignment_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;
