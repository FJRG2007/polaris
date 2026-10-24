-- Notification mutes and schedules per account. Additive only: a null column
-- is no mutes and no schedules, so every account keeps what it had. To reverse,
-- drop the column.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyHolds" TEXT;
