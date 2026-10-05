-- A mail filter as an automation: groups of conditions combined all/any and
-- ordered steps, kept beside the flat columns it grew out of. Additive: no row
-- changes, a filter without it is read from the old columns, and every save
-- still writes those columns too.
--
-- Every statement is written so that running it a second time is a no-op.
--
-- To undo:
--   ALTER TABLE "MailRule" DROP COLUMN IF EXISTS "definition";

-- AlterTable
ALTER TABLE "MailRule" ADD COLUMN IF NOT EXISTS "definition" JSONB;
