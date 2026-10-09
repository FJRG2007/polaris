-- Polaris CRM (apps/crm): companies, people, opportunities and the saved views
-- over them, the `crm.use` permission on the seeded roles that hold the
-- calendar, and the CRM permissions on every organization's seeded member role.
--
-- Every statement is written so that running it a second time is a no-op.
-- CreateTable
CREATE TABLE IF NOT EXISTS "CrmCompany" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT '',
    "employees" INTEGER,
    "annualRevenue" DECIMAL(65,30),
    "annualRevenueCurrency" TEXT NOT NULL DEFAULT '',
    "linkedinUrl" TEXT NOT NULL DEFAULT '',
    "xUrl" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "idealCustomer" BOOLEAN NOT NULL DEFAULT false,
    "accountOwnerId" UUID,
    "createdById" UUID,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CrmPerson" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "jobTitle" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "linkedinUrl" TEXT NOT NULL DEFAULT '',
    "xUrl" TEXT NOT NULL DEFAULT '',
    "companyId" UUID,
    "createdById" UUID,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CrmOpportunity" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(65,30),
    "amountCurrency" TEXT NOT NULL DEFAULT '',
    "closeDate" TIMESTAMP(3),
    "stage" TEXT NOT NULL DEFAULT 'new',
    "companyId" UUID,
    "pointOfContactId" UUID,
    "ownerId" UUID,
    "createdById" UUID,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CrmView" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "shelf" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'table',
    "config" TEXT NOT NULL DEFAULT '{}',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_idx" ON "CrmCompany"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_idx" ON "CrmCompany"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_domain_idx" ON "CrmCompany"("orgId", "domain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_domain_idx" ON "CrmCompany"("userId", "domain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_idx" ON "CrmPerson"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_idx" ON "CrmPerson"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmPerson_companyId_idx" ON "CrmPerson"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_email_idx" ON "CrmPerson"("orgId", "email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_email_idx" ON "CrmPerson"("userId", "email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_stage_idx" ON "CrmOpportunity"("orgId", "deletedAt", "stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_stage_idx" ON "CrmOpportunity"("userId", "deletedAt", "stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmOpportunity_companyId_idx" ON "CrmOpportunity"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmOpportunity_pointOfContactId_idx" ON "CrmOpportunity"("pointOfContactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmView_shelf_object_name_key" ON "CrmView"("shelf", "object", "name");

-- AddForeignKey
ALTER TABLE "CrmCompany" DROP CONSTRAINT IF EXISTS "CrmCompany_orgId_fkey";
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCompany" DROP CONSTRAINT IF EXISTS "CrmCompany_userId_fkey";
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCompany" DROP CONSTRAINT IF EXISTS "CrmCompany_accountOwnerId_fkey";
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_accountOwnerId_fkey" FOREIGN KEY ("accountOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCompany" DROP CONSTRAINT IF EXISTS "CrmCompany_createdById_fkey";
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPerson" DROP CONSTRAINT IF EXISTS "CrmPerson_orgId_fkey";
ALTER TABLE "CrmPerson" ADD CONSTRAINT "CrmPerson_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPerson" DROP CONSTRAINT IF EXISTS "CrmPerson_userId_fkey";
ALTER TABLE "CrmPerson" ADD CONSTRAINT "CrmPerson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPerson" DROP CONSTRAINT IF EXISTS "CrmPerson_companyId_fkey";
ALTER TABLE "CrmPerson" ADD CONSTRAINT "CrmPerson_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPerson" DROP CONSTRAINT IF EXISTS "CrmPerson_createdById_fkey";
ALTER TABLE "CrmPerson" ADD CONSTRAINT "CrmPerson_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_orgId_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_userId_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_companyId_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_pointOfContactId_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_pointOfContactId_fkey" FOREIGN KEY ("pointOfContactId") REFERENCES "CrmPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_ownerId_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOpportunity" DROP CONSTRAINT IF EXISTS "CrmOpportunity_createdById_fkey";
ALTER TABLE "CrmOpportunity" ADD CONSTRAINT "CrmOpportunity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmView" DROP CONSTRAINT IF EXISTS "CrmView_orgId_fkey";
ALTER TABLE "CrmView" ADD CONSTRAINT "CrmView_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmView" DROP CONSTRAINT IF EXISTS "CrmView_userId_fkey";
ALTER TABLE "CrmView" ADD CONSTRAINT "CrmView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Give the seeded member and viewer roles `crm.use`, the way they hold
-- `calendar.use`: a personal CRM is the account's own. Only where it is missing,
-- so a role an operator narrowed on purpose keeps everything else it says.
UPDATE "Role"
SET "permissions" = (("permissions"::jsonb) || '["crm.use"]'::jsonb)::text
WHERE "isSystem" = true
  AND "name" IN ('member', 'viewer')
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["crm.use"]'::jsonb);
