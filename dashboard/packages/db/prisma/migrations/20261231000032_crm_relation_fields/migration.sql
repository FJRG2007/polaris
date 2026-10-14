-- Slot columns for CRM fields that link to other records: each holds the ids
-- of the linked records, one for a single link and up to many for a list.
-- Additive: every existing record starts linked to nothing. An array element
-- cannot carry a foreign key, so the CRM itself removes an id from these
-- lists when the record it names is deleted. To reverse, drop the columns.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "cRel1" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "cRel2" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "cRel3" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmPerson" ADD COLUMN IF NOT EXISTS "cRel1" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmPerson" ADD COLUMN IF NOT EXISTS "cRel2" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmPerson" ADD COLUMN IF NOT EXISTS "cRel3" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmOpportunity" ADD COLUMN IF NOT EXISTS "cRel1" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmOpportunity" ADD COLUMN IF NOT EXISTS "cRel2" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmOpportunity" ADD COLUMN IF NOT EXISTS "cRel3" UUID[] NOT NULL DEFAULT '{}';
