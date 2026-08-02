-- Project settings, membership, and the changeset a destructive edit waits in.
--
-- Deploy has grown past "a project is a folder of services". A project now has
-- people on it, endpoints that report its deploys, tokens that act on it, and
-- behaviour of its own - and none of that had anywhere to live.
--
-- Project.visibility answers who can see it at all: "private" is the owner and
-- whoever was added, "internal" is anyone on the instance already trusted with
-- deploy.read. Defaulting to "private" keeps every project that exists today
-- exactly as visible as it is now.
--
-- Project.flags carries the behaviour toggles as one JSON object rather than a
-- table, for the same reason WafRule.rules does: they are read together on every
-- project load and never addressed one at a time. An empty object means "every
-- flag at its documented default", so a flag added later needs no backfill.
ALTER TABLE "Project" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "Project" ADD COLUMN "flags" TEXT NOT NULL DEFAULT '{}';

-- A token minted from a project's settings may only act on that project. Null is
-- an ordinary account key, which is what every key that exists today is.
ALTER TABLE "ApiKey" ADD COLUMN "projectId" UUID;

CREATE TABLE "ProjectMember" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "invitedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectWebhook" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'generic',
    "targetHint" TEXT NOT NULL,
    "encryptedUrl" BYTEA NOT NULL,
    "urlNonce" BYTEA NOT NULL,
    "urlKeyId" TEXT,
    "events" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastError" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectWebhook_pkey" PRIMARY KEY ("id")
);

-- One parked change. The unique key is the target rather than the row, so a
-- service cannot be queued for deletion twice and a repeated click is idempotent
-- instead of stacking duplicates in the changeset.
CREATE TABLE "StagedChange" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "targetName" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");
CREATE INDEX "ProjectWebhook_projectId_idx" ON "ProjectWebhook"("projectId");
CREATE UNIQUE INDEX "StagedChange_targetType_targetId_kind_key" ON "StagedChange"("targetType", "targetId", "kind");
CREATE INDEX "StagedChange_environmentId_idx" ON "StagedChange"("environmentId");
CREATE INDEX "ApiKey_projectId_idx" ON "ApiKey"("projectId");

ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWebhook" ADD CONSTRAINT "ProjectWebhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StagedChange" ADD CONSTRAINT "StagedChange_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
