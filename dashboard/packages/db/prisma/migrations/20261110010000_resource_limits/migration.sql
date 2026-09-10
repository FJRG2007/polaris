-- The most CPU (cores) and memory (MB) a service's copies and a database may
-- use. Null on everything before, which is no limit.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "cpuLimit" DOUBLE PRECISION;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "memoryLimitMb" INTEGER;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "cpuLimit" DOUBLE PRECISION;
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "memoryLimitMb" INTEGER;
