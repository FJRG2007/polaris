-- Status schedules: the part of the week an account already knows about.
--
-- A window is a wall-clock rule rather than a pair of moments - minutes past
-- midnight and a bitmask of weekdays - so it survives the clocks moving, a
-- change of timezone and next Tuesday without a single row being rewritten. An
-- end at or before the start crosses midnight, which is the common case.
--
-- `presenceSetAt` is the tie-break between a window and a person. A choice made
-- inside an open window is somebody overruling their own rule for this morning
-- and stands until it closes; one made before it opened is the window's to take
-- over. Null on every existing account, which reads as "never chosen" - and
-- since none of them has a window yet either, nothing about them changes.
ALTER TABLE "User" ADD COLUMN     "presenceSetAt" TIMESTAMP(3);

CREATE TABLE "PresenceSchedule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "presence" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresenceSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PresenceSchedule_userId_idx" ON "PresenceSchedule"("userId");

ALTER TABLE "PresenceSchedule" ADD CONSTRAINT "PresenceSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
