-- Several services out of one repository.
--
-- rootDirectory lives in the JSON sourceConfig alongside the repo URL and branch, so
-- there is no column for it here. watchPaths gets one because auto-deploy queries on
-- it: the push handler reads every service tracking a repository and has to decide
-- per service, without decoding each one's source config to do it.
--
-- Null everywhere, which is what keeps every existing service deploying on any push -
-- the behaviour they were configured under.
ALTER TABLE "Application" ADD COLUMN "watchPaths" TEXT;
