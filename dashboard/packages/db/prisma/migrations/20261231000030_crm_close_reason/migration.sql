-- Why a CRM deal was won or lost, as somebody wrote it. Additive: every
-- existing deal starts with none. To reverse, drop the column.

ALTER TABLE "CrmOpportunity" ADD COLUMN IF NOT EXISTS "closeReason" TEXT NOT NULL DEFAULT '';
