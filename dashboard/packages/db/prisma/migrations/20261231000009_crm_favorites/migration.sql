-- CRM records and views somebody pinned to the CRM's rail, per shelf.
-- Additive; to reverse, drop CrmFavorite.

CREATE TABLE IF NOT EXISTS "CrmFavorite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orgId" UUID,
    "kind" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmFavorite_userId_kind_targetId_key" ON "CrmFavorite"("userId", "kind", "targetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmFavorite_userId_orgId_position_idx" ON "CrmFavorite"("userId", "orgId", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmFavorite_targetId_idx" ON "CrmFavorite"("targetId");

-- AddForeignKey
ALTER TABLE "CrmFavorite" DROP CONSTRAINT IF EXISTS "CrmFavorite_userId_fkey";
ALTER TABLE "CrmFavorite" ADD CONSTRAINT "CrmFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmFavorite" DROP CONSTRAINT IF EXISTS "CrmFavorite_orgId_fkey";
ALTER TABLE "CrmFavorite" ADD CONSTRAINT "CrmFavorite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
