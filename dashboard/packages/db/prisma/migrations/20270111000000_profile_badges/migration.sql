-- Profile badges: custom badges an administrator gives out, the day each level
-- of a progress badge was reached, and how each person shows theirs.
--
-- Additive only. Every statement is written so that running it a second time
-- is a no-op.

-- AlterTable
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "badges" TEXT NOT NULL DEFAULT 'everyone';

-- CreateTable
CREATE TABLE IF NOT EXISTS "BadgeDefinition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT 'star',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BadgeDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BadgeGrant" (
    "id" UUID NOT NULL,
    "badgeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BadgeGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BadgeUnlock" (
    "userId" UUID NOT NULL,
    "badge" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BadgeUnlock_pkey" PRIMARY KEY ("userId", "badge", "level")
);

CREATE TABLE IF NOT EXISTS "BadgePreference" (
    "userId" UUID NOT NULL,
    "badge" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "audience" TEXT,
    "listId" UUID,
    "people" UUID[] DEFAULT ARRAY[]::UUID[],
    CONSTRAINT "BadgePreference_pkey" PRIMARY KEY ("userId", "badge")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BadgeGrant_badgeId_userId_key" ON "BadgeGrant"("badgeId", "userId");
CREATE INDEX IF NOT EXISTS "BadgeGrant_userId_idx" ON "BadgeGrant"("userId");
CREATE INDEX IF NOT EXISTS "BadgeUnlock_badge_level_idx" ON "BadgeUnlock"("badge", "level");

-- AddForeignKey
ALTER TABLE "BadgeGrant" DROP CONSTRAINT IF EXISTS "BadgeGrant_badgeId_fkey";
ALTER TABLE "BadgeGrant" ADD CONSTRAINT "BadgeGrant_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "BadgeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BadgeGrant" DROP CONSTRAINT IF EXISTS "BadgeGrant_userId_fkey";
ALTER TABLE "BadgeGrant" ADD CONSTRAINT "BadgeGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BadgeUnlock" DROP CONSTRAINT IF EXISTS "BadgeUnlock_userId_fkey";
ALTER TABLE "BadgeUnlock" ADD CONSTRAINT "BadgeUnlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BadgePreference" DROP CONSTRAINT IF EXISTS "BadgePreference_userId_fkey";
ALTER TABLE "BadgePreference" ADD CONSTRAINT "BadgePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
