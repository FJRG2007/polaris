-- What a call's chat can carry.
--
-- It carried one thing: a line of plain text, up to two thousand characters,
-- with no way to put a picture in it and no way for an address pasted into it to
-- become a link. A call is exactly where somebody needs to hand over a
-- screenshot, a document, or a question for the room to answer - and every one
-- of those had to happen somewhere that was not the call.
--
-- Three things follow.
--
-- Files get a table and a folder of their own rather than the chat's. The
-- chat's housekeeping removes any folder under its root that no conversation
-- answers for, so a meeting's files kept there would be swept by the very sweep
-- they have to survive; and what is written in a call is deleted when the call
-- ends, which wants one folder to delete rather than a walk.
--
-- Polls are voted on by seats rather than by accounts. ChatPoll's votes belong
-- to a User, and half a meeting has no account at all - a poll a guest cannot
-- answer is a poll asked of the wrong people. The price is that somebody who
-- drops out and rejoins takes a new seat and could answer twice, which for a
-- show of hands that lasts as long as the call is the better side of the trade.
--
-- The body column is unchanged and now holds Markdown, the way every other
-- writing surface in Polaris stores it. Anything written before this reads as
-- itself: plain text is valid Markdown.

-- CreateTable
CREATE TABLE "MeetingAttachment" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingPoll" (
    "messageId" UUID NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "hideResults" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingPoll_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "MeetingPollOption" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MeetingPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingPollVote" (
    "id" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingAttachment_messageId_idx" ON "MeetingAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MeetingPollOption_pollId_position_idx" ON "MeetingPollOption"("pollId", "position");

-- CreateIndex
CREATE INDEX "MeetingPollVote_optionId_idx" ON "MeetingPollVote"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingPollVote_optionId_participantId_key" ON "MeetingPollVote"("optionId", "participantId");

-- AddForeignKey
ALTER TABLE "MeetingAttachment" ADD CONSTRAINT "MeetingAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MeetingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingPoll" ADD CONSTRAINT "MeetingPoll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MeetingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingPollOption" ADD CONSTRAINT "MeetingPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "MeetingPoll"("messageId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingPollVote" ADD CONSTRAINT "MeetingPollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "MeetingPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingPollVote" ADD CONSTRAINT "MeetingPollVote_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "MeetingParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

