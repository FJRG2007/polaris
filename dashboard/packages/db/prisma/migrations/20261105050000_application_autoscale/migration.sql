-- The range a service's replica count moves in by itself, and the CPU figure it
-- holds. Null on every service before, which keeps the count where it was set.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "autoscale" TEXT;
