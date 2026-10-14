-- Pages of charts over a shelf's CRM records. Additive; to reverse, drop
-- CrmDashboard.

CREATE TABLE IF NOT EXISTS "CrmDashboard" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "shelf" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "widgets" TEXT NOT NULL DEFAULT '[]',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDashboard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDashboard_shelf_name_key" ON "CrmDashboard"("shelf", "name");

-- AddForeignKey
ALTER TABLE "CrmDashboard" DROP CONSTRAINT IF EXISTS "CrmDashboard_orgId_fkey";
ALTER TABLE "CrmDashboard" ADD CONSTRAINT "CrmDashboard_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDashboard" DROP CONSTRAINT IF EXISTS "CrmDashboard_userId_fkey";
ALTER TABLE "CrmDashboard" ADD CONSTRAINT "CrmDashboard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
