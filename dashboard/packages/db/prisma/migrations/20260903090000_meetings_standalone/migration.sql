-- Meetings that belong to nobody's conversation.
--
-- A call used to be something a conversation had. This is the other kind: a room
-- somebody creates on purpose, hands a link to, and which the people on the
-- other end reach without a Polaris account - and the three things that turns
-- out to need are a time it is meant to happen, a way to say "signed in only",
-- and somewhere to keep what the room typed at each other.
--
-- Every column added here has a default that describes what an existing meeting
-- already was, so nothing that is running while this lands changes behaviour.
ALTER TABLE "Meeting" ADD COLUMN "requireAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN "scheduledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MeetingInvite" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingMessage" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_scheduledAt_idx" ON "Meeting"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingInvite_meetingId_userId_key" ON "MeetingInvite"("meetingId", "userId");

-- CreateIndex
CREATE INDEX "MeetingInvite_userId_idx" ON "MeetingInvite"("userId");

-- CreateIndex
CREATE INDEX "MeetingMessage_meetingId_createdAt_idx" ON "MeetingMessage"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "MeetingInvite" ADD CONSTRAINT "MeetingInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingMessage" ADD CONSTRAINT "MeetingMessage_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingMessage" ADD CONSTRAINT "MeetingMessage_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "MeetingParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
