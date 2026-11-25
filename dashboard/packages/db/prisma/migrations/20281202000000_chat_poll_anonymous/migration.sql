-- Polls choose whether their votes are public or anonymous.
--
-- Until now nothing in Polaris showed who picked what: a poll showed counts and
-- the reader's own answer. A poll may now be public, with a list of who picked
-- each answer, or anonymous, with only the counts ever shown. The choice is made
-- when it is asked and cannot be changed afterwards.
--
-- Every poll that already exists is anonymous: those votes were cast by people
-- who could not be seen casting them, and turning that into a public list now
-- would publish something nobody agreed to share. The column's default is the
-- same, so a write that does not say is the private one.

ALTER TABLE "ChatPoll" ADD COLUMN IF NOT EXISTS "anonymous" BOOLEAN NOT NULL DEFAULT true;
