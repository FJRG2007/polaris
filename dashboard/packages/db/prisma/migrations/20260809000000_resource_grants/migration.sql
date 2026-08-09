-- Grants scoped to one thing, and the invite that can carry one.
--
-- A role permission is compiled as resources:["*"], so it can only ever answer
-- "may this account use the feature at all". Which game server, which project,
-- which space it may act on was answered by ownership alone, and there was no way
-- to say "this person, that server, nothing else". ResourceGrant is that sentence.
--
-- It is the generic form of DriveAcl, which has been doing exactly this for Drive
-- since the beginning: rows compiled into policy statements and resolved by the
-- one engine, with deny-by-default and explicit-deny-override.
--
-- Nothing is backfilled. With no rows, every decision resolves exactly as it did
-- before: ownership plus the global capability.
CREATE TABLE "ResourceGrant" (
    "id" UUID NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" UUID NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "actions" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'allow',
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "grantedById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResourceGrant_principal_resource_key"
    ON "ResourceGrant"("principalType", "principalId", "resourceKind", "resourceId");
CREATE INDEX "ResourceGrant_principalType_principalId_idx"
    ON "ResourceGrant"("principalType", "principalId");
CREATE INDEX "ResourceGrant_resourceKind_resourceId_idx"
    ON "ResourceGrant"("resourceKind", "resourceId");
CREATE INDEX "ResourceGrant_expiresAt_idx" ON "ResourceGrant"("expiresAt");

-- An invite sent by whoever runs a server, carrying the access it promises so the
-- helper arrives already able to help. Null on every invite that exists today,
-- which is what keeps the admin invite flow unchanged.
ALTER TABLE "Invite" ADD COLUMN "pendingGrant" TEXT;
ALTER TABLE "Invite" ADD COLUMN "delegated" BOOLEAN NOT NULL DEFAULT false;
