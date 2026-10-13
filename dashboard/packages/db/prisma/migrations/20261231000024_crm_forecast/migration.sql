-- Stage odds for the CRM forecast, one row per shelf. Additive; to reverse,
-- drop CrmForecast.

CREATE TABLE IF NOT EXISTS "CrmForecast" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "shelf" TEXT NOT NULL,
    "odds" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmForecast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmForecast_shelf_key" ON "CrmForecast"("shelf");

-- AddForeignKey
ALTER TABLE "CrmForecast" DROP CONSTRAINT IF EXISTS "CrmForecast_orgId_fkey";
ALTER TABLE "CrmForecast" ADD CONSTRAINT "CrmForecast_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmForecast" DROP CONSTRAINT IF EXISTS "CrmForecast_userId_fkey";
ALTER TABLE "CrmForecast" ADD CONSTRAINT "CrmForecast_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
