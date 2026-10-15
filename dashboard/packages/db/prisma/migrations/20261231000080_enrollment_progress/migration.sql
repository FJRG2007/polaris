-- The step-by-step log of adding a server, shown live while it happens. One
-- nullable column; existing enrollments simply have no log. To reverse, drop
-- the column.

ALTER TABLE "Enrollment" ADD COLUMN IF NOT EXISTS "progress" JSONB;
