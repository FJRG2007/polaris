-- Polar skills: instructions for one kind of task that a person keeps, listed to
-- the model by name and description and read in full only when it applies. A
-- new table only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "PolarSkill".
CREATE TABLE IF NOT EXISTS "PolarSkill" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'custom',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarSkill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarSkill_ownerId_name_key" ON "PolarSkill"("ownerId", "name");

ALTER TABLE "PolarSkill" DROP CONSTRAINT IF EXISTS "PolarSkill_ownerId_fkey";
ALTER TABLE "PolarSkill" ADD CONSTRAINT "PolarSkill_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
