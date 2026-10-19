-- Where a Polar thread's title came from, so the model names a new thread once
-- and never replaces a title somebody chose. Existing threads read "user": none
-- of them is ever renamed by the model.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "titleSource" TEXT NOT NULL DEFAULT 'user';
