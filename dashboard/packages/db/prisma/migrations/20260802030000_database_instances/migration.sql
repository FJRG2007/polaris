-- Databases that share an instance, and the account that reaches one.
--
-- A managed database used to be exactly one container: five small apps that each
-- wanted a Postgres paid for five engine processes and five data volumes. A
-- database may now instead be created inside an instance that is already
-- running, which is what ManagedDatabase.parentId records. Such a row has no
-- image, volume or container of its own - those columns stay empty - and is
-- reached through its parent's container and port with its own user and
-- password. Null is a dedicated instance, which is what every database that
-- exists today is, so nothing needs backfilling.
--
-- The foreign key cascades: dropping an instance drops the databases that only
-- existed inside it, because there is nothing left for them to be reached
-- through. The service layer still drops them from the engine first, so the
-- data goes with the row rather than being orphaned inside the container.
ALTER TABLE "ManagedDatabase" ADD COLUMN "parentId" UUID;

-- What the database's own user may do inside it: owner (it owns the database),
-- readwrite, or readonly. Existing databases were created with a user that owns
-- everything, so 'owner' is both the default and the honest backfill.
ALTER TABLE "ManagedDatabase" ADD COLUMN "privileges" TEXT NOT NULL DEFAULT 'owner';

CREATE INDEX "ManagedDatabase_parentId_idx" ON "ManagedDatabase"("parentId");

ALTER TABLE "ManagedDatabase" ADD CONSTRAINT "ManagedDatabase_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
