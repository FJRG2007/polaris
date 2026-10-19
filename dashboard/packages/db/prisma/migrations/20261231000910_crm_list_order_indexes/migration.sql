-- The orders a CRM list offers, each read through an index on the shelf it is
-- narrowed to: a list of a hundred thousand records pages from the index
-- instead of sorting the whole shelf for every page.

CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_createdAt_idx" ON "CrmCompany"("orgId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_updatedAt_idx" ON "CrmCompany"("orgId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_name_idx" ON "CrmCompany"("orgId", "deletedAt", "name");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_employees_idx" ON "CrmCompany"("orgId", "deletedAt", "employees");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_annualRevenue_idx" ON "CrmCompany"("orgId", "deletedAt", "annualRevenue");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_city_idx" ON "CrmCompany"("orgId", "deletedAt", "city");
CREATE INDEX IF NOT EXISTS "CrmCompany_orgId_deletedAt_country_idx" ON "CrmCompany"("orgId", "deletedAt", "country");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_createdAt_idx" ON "CrmCompany"("userId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_updatedAt_idx" ON "CrmCompany"("userId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_name_idx" ON "CrmCompany"("userId", "deletedAt", "name");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_employees_idx" ON "CrmCompany"("userId", "deletedAt", "employees");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_annualRevenue_idx" ON "CrmCompany"("userId", "deletedAt", "annualRevenue");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_city_idx" ON "CrmCompany"("userId", "deletedAt", "city");
CREATE INDEX IF NOT EXISTS "CrmCompany_userId_deletedAt_country_idx" ON "CrmCompany"("userId", "deletedAt", "country");
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_createdAt_idx" ON "CrmPerson"("orgId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_updatedAt_idx" ON "CrmPerson"("orgId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_firstName_lastName_idx" ON "CrmPerson"("orgId", "deletedAt", "firstName", "lastName");
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_jobTitle_idx" ON "CrmPerson"("orgId", "deletedAt", "jobTitle");
CREATE INDEX IF NOT EXISTS "CrmPerson_orgId_deletedAt_city_idx" ON "CrmPerson"("orgId", "deletedAt", "city");
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_createdAt_idx" ON "CrmPerson"("userId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_updatedAt_idx" ON "CrmPerson"("userId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_firstName_lastName_idx" ON "CrmPerson"("userId", "deletedAt", "firstName", "lastName");
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_jobTitle_idx" ON "CrmPerson"("userId", "deletedAt", "jobTitle");
CREATE INDEX IF NOT EXISTS "CrmPerson_userId_deletedAt_city_idx" ON "CrmPerson"("userId", "deletedAt", "city");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_createdAt_idx" ON "CrmOpportunity"("orgId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_updatedAt_idx" ON "CrmOpportunity"("orgId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_name_idx" ON "CrmOpportunity"("orgId", "deletedAt", "name");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_amount_idx" ON "CrmOpportunity"("orgId", "deletedAt", "amount");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_closeDate_idx" ON "CrmOpportunity"("orgId", "deletedAt", "closeDate");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_orgId_deletedAt_stage_position_idx" ON "CrmOpportunity"("orgId", "deletedAt", "stage", "position");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_createdAt_idx" ON "CrmOpportunity"("userId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_updatedAt_idx" ON "CrmOpportunity"("userId", "deletedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_name_idx" ON "CrmOpportunity"("userId", "deletedAt", "name");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_amount_idx" ON "CrmOpportunity"("userId", "deletedAt", "amount");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_closeDate_idx" ON "CrmOpportunity"("userId", "deletedAt", "closeDate");
CREATE INDEX IF NOT EXISTS "CrmOpportunity_userId_deletedAt_stage_position_idx" ON "CrmOpportunity"("userId", "deletedAt", "stage", "position");
