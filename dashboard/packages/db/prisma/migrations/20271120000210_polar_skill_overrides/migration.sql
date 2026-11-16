-- Edits layered over built-in and Enigma skills, per person or for the whole
-- instance (apps/web/src/lib/polar/skills/overrides.ts). Rerunnable.
CREATE TABLE IF NOT EXISTS "PolarSkillOverride" (
    "id" UUID NOT NULL,
    "owner" TEXT NOT NULL,
    "userId" UUID,
    "skill" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "baseDescription" TEXT,
    "baseInstructions" TEXT,
    "enabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolarSkillOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarSkillOverride_owner_skill_key" ON "PolarSkillOverride"("owner", "skill");

CREATE INDEX IF NOT EXISTS "PolarSkillOverride_userId_idx" ON "PolarSkillOverride"("userId");

ALTER TABLE "PolarSkillOverride" DROP CONSTRAINT IF EXISTS "PolarSkillOverride_userId_fkey";
ALTER TABLE "PolarSkillOverride" ADD CONSTRAINT "PolarSkillOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
