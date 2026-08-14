-- A vault can now belong to one person instead of to a Polaris organization.
-- Every existing row belongs to an organization, so the column is only relaxed;
-- nothing is rewritten.
ALTER TABLE "VaultOrganization" ALTER COLUMN "organizationId" DROP NOT NULL;
ALTER TABLE "VaultOrganization" ADD COLUMN     "ownerUserId" UUID;
ALTER TABLE "VaultOrganization" ADD COLUMN     "name" TEXT;

CREATE INDEX "VaultOrganization_ownerUserId_idx" ON "VaultOrganization"("ownerUserId");

ALTER TABLE "VaultOrganization" ADD CONSTRAINT "VaultOrganization_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner. Both set would make it unclear which roster governs it, and
-- neither set would be a vault nobody can administer and nothing can delete.
ALTER TABLE "VaultOrganization" ADD CONSTRAINT "VaultOrganization_one_owner" CHECK (("organizationId" IS NULL) <> ("ownerUserId" IS NULL));
