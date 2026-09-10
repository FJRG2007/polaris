-- A monthly budget an organization can set on what it deploys, announced to the
-- people running it at 80% and at 100%.
--
-- A new table and nothing else, so an instance that updates behaves exactly as
-- before until somebody sets one. Written to be safe to run twice: the
-- entrypoint retries migrations, and an update can kill the container part-way
-- through one.
CREATE TABLE IF NOT EXISTS "OrganizationBudget" (
    "orgId" UUID NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "alertedMonth" TEXT,
    "alertedLevel" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationBudget_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "OrganizationBudget" DROP CONSTRAINT IF EXISTS "OrganizationBudget_orgId_fkey";
ALTER TABLE "OrganizationBudget" ADD CONSTRAINT "OrganizationBudget_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
