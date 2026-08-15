-- Meetings: calls started from a conversation, joinable by a guest link.
--
-- New tables only. Media never reaches Polaris - the browsers connect to each
-- other - so what is stored is who was in the room and how somebody gets into
-- it, never a second of audio.

-- CreateTable
CREATE TABLE "Meeting" (
    "id" UUID NOT NULL,
    "channelId" UUID,
    "hostId" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "guestToken" TEXT,
    "approveGuests" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingParticipant" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "guestKey" TEXT,
    "admission" TEXT NOT NULL DEFAULT 'admitted',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_guestToken_key" ON "Meeting"("guestToken");

-- CreateIndex
CREATE INDEX "Meeting_channelId_endedAt_idx" ON "Meeting"("channelId", "endedAt");

-- CreateIndex
CREATE INDEX "Meeting_endedAt_idx" ON "Meeting"("endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingParticipant_guestKey_key" ON "MeetingParticipant"("guestKey");

-- CreateIndex
CREATE INDEX "MeetingParticipant_meetingId_leftAt_idx" ON "MeetingParticipant"("meetingId", "leftAt");

-- CreateIndex
CREATE INDEX "MeetingParticipant_meetingId_admission_idx" ON "MeetingParticipant"("meetingId", "admission");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

