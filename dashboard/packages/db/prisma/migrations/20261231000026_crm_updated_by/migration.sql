-- Who last changed a CRM record. Additive and nullable: existing records read
-- as never changed by anybody named. To reverse, drop the three columns.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "updatedById" UUID;
ALTER TABLE "CrmCompany" DROP CONSTRAINT IF EXISTS "CrmCompany_updatedById_fkey";
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmPerson" ADD COLUMN IF NOT EXISTS "updatedById" UUID;
ALTER TABLE "CrmPerson" DROP CONSTRAINT IF EXISTS "CrmPerson_updatedById_fkey";
ALTER TABLE "CrmPerson" ADD CONSTRAINT "CrmPerson_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmOpportunity" ADD COLUMN IF NOT EXISTS "updatedById" UUID;
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_updatedById_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
