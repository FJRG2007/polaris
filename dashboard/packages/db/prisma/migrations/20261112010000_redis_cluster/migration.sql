-- Redis Cluster: the number of masters (3, 5 or 7, each with one replica) a
-- managed Redis runs as. Null on every database before, which is a single instance.
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "clusterMasters" INTEGER;
