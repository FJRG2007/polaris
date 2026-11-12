-- CreateTable
CREATE TABLE IF NOT EXISTS "ClockStopwatchLane" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "elapsedMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laps" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClockStopwatchLane_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClockStopwatchLane_userId_createdAt_idx" ON "ClockStopwatchLane"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClockStopwatchLane" DROP CONSTRAINT IF EXISTS "ClockStopwatchLane_userId_fkey";
ALTER TABLE "ClockStopwatchLane" ADD CONSTRAINT "ClockStopwatchLane_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
