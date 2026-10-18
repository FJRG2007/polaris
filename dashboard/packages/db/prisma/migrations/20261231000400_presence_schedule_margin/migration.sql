-- AlterTable
ALTER TABLE "PresenceSchedule" ADD COLUMN IF NOT EXISTS "marginMinutes" INTEGER NOT NULL DEFAULT 0;
