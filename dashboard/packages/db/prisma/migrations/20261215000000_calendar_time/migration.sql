-- Calendar's Time area: alarms, timers and the stopwatch.
--
-- Three new tables owned by one person each, removed with the account. Nothing
-- that exists today is read or changed.
--
-- Every statement is written so that running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ClockAlarm" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "time" TEXT NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL DEFAULT '',
    "sound" TEXT NOT NULL DEFAULT 'chime',
    "snoozeMinutes" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "zone" TEXT NOT NULL,
    "nextFireAt" TIMESTAMP(3),
    "snoozed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClockAlarm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ClockTimer" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL,
    "sound" TEXT NOT NULL DEFAULT 'chime',
    "endsAt" TIMESTAMP(3),
    "remainingMs" INTEGER,
    "firedAt" TIMESTAMP(3),
    "pomodoro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClockTimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ClockStopwatch" (
    "userId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3),
    "elapsedMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laps" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClockStopwatch_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClockAlarm_userId_idx" ON "ClockAlarm"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClockAlarm_nextFireAt_idx" ON "ClockAlarm"("nextFireAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClockTimer_userId_idx" ON "ClockTimer"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClockTimer_endsAt_idx" ON "ClockTimer"("endsAt");

-- AddForeignKey
ALTER TABLE "ClockAlarm" DROP CONSTRAINT IF EXISTS "ClockAlarm_userId_fkey";
ALTER TABLE "ClockAlarm" ADD CONSTRAINT "ClockAlarm_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockTimer" DROP CONSTRAINT IF EXISTS "ClockTimer_userId_fkey";
ALTER TABLE "ClockTimer" ADD CONSTRAINT "ClockTimer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockStopwatch" DROP CONSTRAINT IF EXISTS "ClockStopwatch_userId_fkey";
ALTER TABLE "ClockStopwatch" ADD CONSTRAINT "ClockStopwatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
