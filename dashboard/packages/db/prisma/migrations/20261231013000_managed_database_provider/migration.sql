-- An instance that lives in a cloud instead of on a server. Additive; reverse with
-- ALTER TABLE "ManagedDatabase" DROP COLUMN "provider", DROP COLUMN "providerResourceId";
ALTER TABLE "ManagedDatabase" ADD COLUMN "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN "providerResourceId" TEXT;
