-- Whether a camera is still there. `lastSeenAt` is the last time it answered and
-- `offlineSince` is when it stopped, so an outage has a length and the alert for
-- it can be raised exactly once.

-- AlterTable
ALTER TABLE "Camera" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "offlineSince" TIMESTAMP(3);
