-- A meeting's join code, and the addresses its host asked to it. Additive: a
-- nullable column and a new table, so every existing meeting is unchanged.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "joinCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_joinCode_key" ON "Meeting"("joinCode");

-- CreateTable
CREATE TABLE "MeetingEmailInvite" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingEmailInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingEmailInvite_meetingId_email_key" ON "MeetingEmailInvite"("meetingId", "email");

-- AddForeignKey
ALTER TABLE "MeetingEmailInvite" ADD CONSTRAINT "MeetingEmailInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
