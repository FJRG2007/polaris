-- Named sets of servers, so a firewall rule can be written once for "the VPS boxes"
-- rather than once per machine.
--
-- Membership only: a group holds no settings of its own. It earns its place by being
-- a firewall scope like any other, merging into every service that runs on any of its
-- members. Cascades both ways - deleting a group forgets the membership, and so does
-- deleting a server, so neither leaves a rule pointing at something that is gone.
CREATE TABLE "HostGroup" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostGroup_ownerId_name_key" ON "HostGroup"("ownerId", "name");

CREATE INDEX "HostGroup_ownerId_idx" ON "HostGroup"("ownerId");

CREATE TABLE "HostGroupMember" (
    "groupId" UUID NOT NULL,
    "hostId" UUID NOT NULL,

    CONSTRAINT "HostGroupMember_pkey" PRIMARY KEY ("groupId","hostId")
);

CREATE INDEX "HostGroupMember_hostId_idx" ON "HostGroupMember"("hostId");

ALTER TABLE "HostGroup" ADD CONSTRAINT "HostGroup_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HostGroupMember" ADD CONSTRAINT "HostGroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "HostGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HostGroupMember" ADD CONSTRAINT "HostGroupMember_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;
