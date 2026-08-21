-- Polls: a question asked in a conversation, and the answers under it.
--
-- Keyed by the message rather than by an id of its own. A poll is a message, and
-- there is exactly one per message - which is also why the question is not a
-- column here: it is the message's body, so searching, quoting, forwarding and
-- the rail's preview all reach it through paths that already existed.
--
-- Nothing is denormalized. The tallies are counted from the votes on read; a
-- running count kept on the poll would be a second source of truth for the one
-- number the feature is about, and a vote lost in a retry would leave it wrong
-- forever with nothing to compare it against.
CREATE TABLE "ChatPoll" (
    "messageId" UUID NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "hideResults" BOOLEAN NOT NULL DEFAULT false,
    "closesAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPoll_pkey" PRIMARY KEY ("messageId")
);

CREATE TABLE "ChatPollOption" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ChatPollOption_pkey" PRIMARY KEY ("id")
);

-- One row per answer picked rather than one per voter, so a poll that allows
-- several is the same shape as one that does not. Taking a vote back deletes the
-- row: a poll is a count of who stands where now, not a history of who moved.
CREATE TABLE "ChatPollVote" (
    "id" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPollVote_pkey" PRIMARY KEY ("id")
);

-- What a sweep would ask for, if one is ever wanted: which polls have run out.
CREATE INDEX "ChatPoll_closesAt_idx" ON "ChatPoll"("closesAt");
-- The answers of one poll, in the order they were written.
CREATE INDEX "ChatPollOption_pollId_position_idx" ON "ChatPollOption"("pollId", "position");
CREATE INDEX "ChatPollVote_optionId_idx" ON "ChatPollVote"("optionId");
CREATE INDEX "ChatPollVote_userId_idx" ON "ChatPollVote"("userId");
-- One vote per person per answer, in the database rather than only in the
-- service: a double press that raced past the check must not count twice.
CREATE UNIQUE INDEX "ChatPollVote_optionId_userId_key" ON "ChatPollVote"("optionId", "userId");

ALTER TABLE "ChatPoll" ADD CONSTRAINT "ChatPoll_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatPollOption" ADD CONSTRAINT "ChatPollOption_pollId_fkey"
    FOREIGN KEY ("pollId") REFERENCES "ChatPoll"("messageId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "ChatPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
