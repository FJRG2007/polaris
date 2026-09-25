-- Whether a file waiting on a scheduled message is somebody's own Drive file,
-- shared rather than copied. The sending pass already read this column, so
-- every pass failed until it existed; and cancelling needs it too, so it never
-- deletes a Drive file that was only borrowed.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ChatScheduledFile" ADD COLUMN IF NOT EXISTS "borrowed" BOOLEAN NOT NULL DEFAULT false;
