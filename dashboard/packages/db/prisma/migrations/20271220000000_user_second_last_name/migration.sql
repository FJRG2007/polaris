-- The second surname of a person's name. Additive and nullable: existing
-- accounts keep their stored surname untouched and simply have none.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "secondLastName" TEXT;
