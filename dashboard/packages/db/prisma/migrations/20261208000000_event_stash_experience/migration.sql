-- A kept bag keeps the experience taken with it, given back with the stacks.
-- Written so that running it a second time is a no-op.
ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "experience" TEXT;
