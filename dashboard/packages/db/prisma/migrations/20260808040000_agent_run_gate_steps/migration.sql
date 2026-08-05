-- What the Enigma quality gate reported, step by step.
--
-- On the run rather than in the container log: the run screen has to be able to
-- show the pipeline working, and reading a log to find out would mean the two
-- GitHub-scheduled executions could never show it at all.
ALTER TABLE "AgentRun" ADD COLUMN "gateSteps" TEXT;
