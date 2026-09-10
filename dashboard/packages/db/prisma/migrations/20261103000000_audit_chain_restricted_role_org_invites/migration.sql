-- The audit trail becomes tamper-evident, organizations gain a role that holds
-- nothing until something is granted, and an organization can invite somebody
-- who has no account yet.
--
-- Every column is nullable or defaulted, so an instance that updates keeps
-- behaving exactly as before: no entry is sealed until the sealing pass reaches
-- it, no member is restricted, every organization keeps offering `member`, and no
-- existing invite names an organization.

-- The chain. Filled in by the sealing pass, oldest entry first.
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "seq" BIGINT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "hash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_seq_key" ON "AuditLog"("seq");

-- Where retention cut the chain, so the entries after the cut still verify.
CREATE TABLE IF NOT EXISTS "AuditCheckpoint" (
    "id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "pruned" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditCheckpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AuditCheckpoint_seq_key" ON "AuditCheckpoint"("seq");

-- The restricted role, and its mirror on each membership.
ALTER TABLE "OrgRole" ADD COLUMN IF NOT EXISTS "restricted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationMember" ADD COLUMN IF NOT EXISTS "restricted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "defaultInviteRole" TEXT NOT NULL DEFAULT 'member';

-- An instance invite that also joins an organization.
ALTER TABLE "Invite" ADD COLUMN IF NOT EXISTS "orgId" UUID;
ALTER TABLE "Invite" ADD COLUMN IF NOT EXISTS "orgRole" TEXT;
CREATE INDEX IF NOT EXISTS "Invite_orgId_idx" ON "Invite"("orgId");
