-- Handing one thing to somebody who is not on its roster: the security team gets
-- that camera and nothing else, the cleaner opens the front door on Tuesdays
-- between nine and eleven. Addressed by kind and id in both directions rather
-- than by foreign key, because it spans six kinds of subject across four apps.
CREATE TABLE IF NOT EXISTS "AccessGrant" (
    "id" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "days" INTEGER NOT NULL DEFAULT 127,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "timeZone" TEXT NOT NULL DEFAULT '',
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "grantedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- Both directions are read constantly: what one thing hands out draws a screen,
-- and what one person reaches runs on the way into one.
CREATE INDEX IF NOT EXISTS "AccessGrant_subjectType_subjectId_idx" ON "AccessGrant"("subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "AccessGrant_principalType_principalId_idx" ON "AccessGrant"("principalType", "principalId");
