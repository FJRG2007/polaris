-- How a dedicated database instance is laid out: one container, a MongoDB
-- replica set or sharded cluster, or MySQL with read replicas. Every instance
-- written before this is a single one, which is what the defaults say.
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "topology" TEXT NOT NULL DEFAULT 'single';
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "members" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "shards" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "readReplicas" INTEGER NOT NULL DEFAULT 0;
