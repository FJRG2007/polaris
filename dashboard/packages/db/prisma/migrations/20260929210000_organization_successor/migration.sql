-- The account an organization's owner named to take it over if they are gone.
--
-- Beside AccountSuccessor and deliberately not the same row: an owner of four
-- organizations may want a different person to close each one. With this unset
-- the owner's own successor still answers, which is what happened before and
-- what most owners will never have to think about.
--
-- Written to be safe to run twice. The entrypoint retries migrations, and an
-- update can kill the container part-way through one.
CREATE TABLE IF NOT EXISTS "OrganizationSuccessor" (
    "orgId" UUID NOT NULL,
    "successorId" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSuccessor_pkey" PRIMARY KEY ("orgId")
);

CREATE INDEX IF NOT EXISTS "OrganizationSuccessor_successorId_idx"
    ON "OrganizationSuccessor"("successorId");

DO $$
BEGIN
    ALTER TABLE "OrganizationSuccessor"
        ADD CONSTRAINT "OrganizationSuccessor_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "OrganizationSuccessor"
        ADD CONSTRAINT "OrganizationSuccessor_successorId_fkey"
        FOREIGN KEY ("successorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
