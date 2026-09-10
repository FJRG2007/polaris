-- How an environment's services see each other. Every existing environment
-- keeps "shared", which is exactly what it did before.
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "networkMode" TEXT NOT NULL DEFAULT 'shared';
