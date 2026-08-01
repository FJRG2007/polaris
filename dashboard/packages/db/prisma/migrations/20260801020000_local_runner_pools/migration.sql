-- A runner pool can now run on the box Polaris itself runs on, which has no Host
-- row: there are no credentials to store for the machine serving the request, so
-- it is reached through polaris-hostd rather than over SSH. A null hostId is that
-- machine, exactly like a deploy target of kind "local".
ALTER TABLE "RunnerPool" ALTER COLUMN "hostId" DROP NOT NULL;
