-- The services a project runs somewhere that is not Polaris.
--
-- The same repository is often on a Polaris server for staging and on Vercel or
-- Railway for production, and half of that was invisible from here. This is that
-- half, on the same board: what it is called, what it last released, whether it
-- worked, and where it can be reached.
--
-- Deliberately not an Application. That table is a container Polaris builds,
-- places on a target, routes and can open a shell on, and none of those words
-- mean anything about a service somebody else builds and serves.
--
-- No credential is stored here. The provider is reached through the
-- UserConnection the person made under Connected accounts, so revoking the link
-- revokes this. No foreign key onto it: a link that goes leaves a row that says
-- it cannot be read rather than a row that vanished, which is the difference
-- between a service somebody can reconnect and a service they have to remember.
--
-- IF NOT EXISTS throughout, and the foreign key dropped by name before it is
-- added, so a run that failed partway is finished by running it again.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ExternalService" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "connectionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "url" TEXT,
    "inspectUrl" TEXT,
    "lastDeployAt" TIMESTAMP(3),
    "lastCommitSha" TEXT,
    "lastCommitMessage" TEXT,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One name per environment, the way an application and a database are named:
-- the board shows all three side by side and two of them called the same thing
-- is a board nobody can read.
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalService_environmentId_slug_key" ON "ExternalService"("environmentId", "slug");
CREATE INDEX IF NOT EXISTS "ExternalService_environmentId_idx" ON "ExternalService"("environmentId");
CREATE INDEX IF NOT EXISTS "ExternalService_connectionId_idx" ON "ExternalService"("connectionId");

-- AddForeignKey
ALTER TABLE "ExternalService" DROP CONSTRAINT IF EXISTS "ExternalService_environmentId_fkey";
ALTER TABLE "ExternalService" ADD CONSTRAINT "ExternalService_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
