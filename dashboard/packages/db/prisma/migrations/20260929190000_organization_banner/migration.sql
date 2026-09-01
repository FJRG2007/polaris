-- The wide picture across the top of an organization's page.
--
-- Written to be safe to run twice. The entrypoint retries migrations, and an
-- update can kill the container part-way through one, so a statement that
-- refuses on the second attempt takes the whole ledger down with it.
CREATE TABLE IF NOT EXISTS "OrganizationBanner" (
    "orgId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationBanner_pkey" PRIMARY KEY ("orgId")
);

DO $$
BEGIN
    ALTER TABLE "OrganizationBanner"
        ADD CONSTRAINT "OrganizationBanner_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
