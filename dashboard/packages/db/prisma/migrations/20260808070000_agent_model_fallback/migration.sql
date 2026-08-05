-- Somewhere else to try when a provider will not serve the run.
--
-- A run refused for the account's rate ceiling, an empty balance, a rejected
-- key or a model that no longer exists is not a run that failed at its work: it
-- never started. Until now that was the end of it, and somebody had to notice
-- and re-point the repository by hand.
ALTER TABLE "AgentDefaults" ADD COLUMN "fallback" TEXT;

-- A retry is a second attempt at ONE piece of work. Kept as a chain rather than
-- as unrelated rows so the runs screen can say so, and so the count is what
-- stops a broken chain from dispatching forever.
ALTER TABLE "AgentRun" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AgentRun" ADD COLUMN "parentRunId" UUID;
-- Which classification the failure landed on, as a value rather than as the
-- prose in `error`: deciding whether to try the next candidate by reading
-- sentences would break the first time one was reworded.
ALTER TABLE "AgentRun" ADD COLUMN "failureKind" TEXT;

CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

-- What the agent was asked. A retry has to ask the same thing, and a
-- webhook-triggered run cannot rebuild it: the event is long gone.
ALTER TABLE "AgentRun" ADD COLUMN "prompt" TEXT;
