-- The slots a give-back is writing back, so one that stops halfway knows which
-- stacks it put there itself. Written so that running it a second time is a no-op.
ALTER TABLE "EventInventoryStash" ADD COLUMN IF NOT EXISTS "writing" TEXT;
