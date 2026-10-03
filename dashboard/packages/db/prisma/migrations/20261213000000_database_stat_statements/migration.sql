-- A managed PostgreSQL instance can be started with pg_stat_statements loaded,
-- which is what lets its Stats screen say which statements it spends its time on.

ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "statStatements" BOOLEAN NOT NULL DEFAULT false;
