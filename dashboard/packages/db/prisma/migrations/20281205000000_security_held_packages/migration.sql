-- The packages a server keeps where they are, as its last status read listed them.
--
-- Additive: a new column with an empty default, so every existing row reads as
-- "nothing held" until its next read.
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "heldPackages" TEXT[] DEFAULT ARRAY[]::TEXT[];
