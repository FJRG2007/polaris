-- Sealed poll votes.
--
-- In a sealed conversation a vote is sealed in the voter's browser, so the
-- server keeps one opaque ballot per voter and never learns which answer they
-- picked; the tally is made in each member's browser. Additive: plain polls,
-- and the vote rows of polls that already exist, are untouched.

CREATE TABLE IF NOT EXISTS "ChatPollBallot" (
    "pollId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ballotId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "sealed" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPollBallot_pkey" PRIMARY KEY ("pollId", "userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatPollBallot_pollId_ballotId_key" ON "ChatPollBallot"("pollId", "ballotId");
CREATE INDEX IF NOT EXISTS "ChatPollBallot_userId_idx" ON "ChatPollBallot"("userId");

DO $$ BEGIN
    ALTER TABLE "ChatPollBallot" ADD CONSTRAINT "ChatPollBallot_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ChatPoll"("messageId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatPollBallot" ADD CONSTRAINT "ChatPollBallot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
