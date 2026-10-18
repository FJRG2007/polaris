-- AlterTable
ALTER TABLE "ClockAlarm" ADD COLUMN IF NOT EXISTS "stoppedDue" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ClockTimer" ADD COLUMN IF NOT EXISTS "stoppedDue" TIMESTAMP(3);
