-- An administrator can hand somebody a temporary password that has to be
-- replaced at their next sign-in. Additive only: every existing account starts
-- with the flag off, which is what it had. To reverse, drop the column.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT false;
