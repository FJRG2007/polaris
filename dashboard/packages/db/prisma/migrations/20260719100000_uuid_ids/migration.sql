-- Convert every surrogate id and id reference from a text CUID to a native uuid,
-- preserving all data and relationships. The mapping is deterministic: an id X
-- becomes md5(X)::uuid, and every column that referenced X is remapped with the
-- same function, so foreign keys stay matched without any join. NULLs stay NULL.
-- Natural keys (GeoIpCache.ip, *.key) are left as text.
--
-- Ordering: drop all foreign keys, retype every id/reference column, re-add the
-- foreign keys, then add the new User ban columns. Postgres runs the whole file
-- in one transaction, so a failure rolls back cleanly.
--
-- BACKUP BEFORE APPLYING. This was authored against the schema, not run against a
-- live Postgres in development (dev uses SQLite); dry-run it on a copy first.

-- 1. Drop every foreign key so the referenced/refereeing columns can be retyped.
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_userId_fkey";
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_roleId_fkey";
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_invitedById_fkey";
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_groupId_fkey";
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_userId_fkey";
ALTER TABLE "PolicyAttachment" DROP CONSTRAINT "PolicyAttachment_policyId_fkey";
ALTER TABLE "DriveAcl" DROP CONSTRAINT "DriveAcl_connectionId_fkey";
ALTER TABLE "AccessLock" DROP CONSTRAINT "AccessLock_connectionId_fkey";
ALTER TABLE "StorageConnection" DROP CONSTRAINT "StorageConnection_ownerId_fkey";
ALTER TABLE "ScheduledDeletion" DROP CONSTRAINT "ScheduledDeletion_connectionId_fkey";
ALTER TABLE "TrashItem" DROP CONSTRAINT "TrashItem_connectionId_fkey";
ALTER TABLE "DriveItemMeta" DROP CONSTRAINT "DriveItemMeta_connectionId_fkey";
ALTER TABLE "DockerConnection" DROP CONSTRAINT "DockerConnection_ownerId_fkey";
ALTER TABLE "StorageMount" DROP CONSTRAINT "StorageMount_connectionId_fkey";
ALTER TABLE "Node" DROP CONSTRAINT "Node_connectionId_fkey";
ALTER TABLE "Share" DROP CONSTRAINT "Share_connectionId_fkey";
ALTER TABLE "Share" DROP CONSTRAINT "Share_nodeId_fkey";
ALTER TABLE "Share" DROP CONSTRAINT "Share_ownerId_fkey";
ALTER TABLE "ShareInvite" DROP CONSTRAINT "ShareInvite_shareId_fkey";
ALTER TABLE "ShareInvite" DROP CONSTRAINT "ShareInvite_userId_fkey";
ALTER TABLE "ShareAccessLog" DROP CONSTRAINT "ShareAccessLog_shareId_fkey";
ALTER TABLE "FileRequest" DROP CONSTRAINT "FileRequest_ownerId_fkey";
ALTER TABLE "FileRequest" DROP CONSTRAINT "FileRequest_destinationConnectionId_fkey";
ALTER TABLE "FileRequestSubmission" DROP CONSTRAINT "FileRequestSubmission_requestId_fkey";
ALTER TABLE "FileRequestSubmission" DROP CONSTRAINT "FileRequestSubmission_submittedByUserId_fkey";
ALTER TABLE "FileRequestSubmission" DROP CONSTRAINT "FileRequestSubmission_storedNodeId_fkey";
ALTER TABLE "UploadSession" DROP CONSTRAINT "UploadSession_ownerId_fkey";
ALTER TABLE "UploadSession" DROP CONSTRAINT "UploadSession_connectionId_fkey";
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- 2. Retype every id / id-reference column to uuid via the deterministic mapping.
ALTER TABLE "User" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "Session" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Session" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "Account" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Account" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "Verification" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "Role" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "UserRole" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);
ALTER TABLE "UserRole" ALTER COLUMN "roleId" TYPE UUID USING (md5("roleId")::uuid);

ALTER TABLE "Invite" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Invite" ALTER COLUMN "roleId" TYPE UUID USING (md5("roleId")::uuid);
ALTER TABLE "Invite" ALTER COLUMN "invitedById" TYPE UUID USING (md5("invitedById")::uuid);

ALTER TABLE "Group" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "GroupMember" ALTER COLUMN "groupId" TYPE UUID USING (md5("groupId")::uuid);
ALTER TABLE "GroupMember" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "Policy" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "PolicyAttachment" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "PolicyAttachment" ALTER COLUMN "policyId" TYPE UUID USING (md5("policyId")::uuid);
ALTER TABLE "PolicyAttachment" ALTER COLUMN "principalId" TYPE UUID USING (md5("principalId")::uuid);

ALTER TABLE "DriveAcl" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "DriveAcl" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "DriveAcl" ALTER COLUMN "principalId" TYPE UUID USING (md5("principalId")::uuid);
ALTER TABLE "DriveAcl" ALTER COLUMN "createdById" TYPE UUID USING (md5("createdById")::uuid);

ALTER TABLE "AccessLock" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "AccessLock" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "AccessLock" ALTER COLUMN "createdById" TYPE UUID USING (md5("createdById")::uuid);

ALTER TABLE "StorageConnection" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "StorageConnection" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);

ALTER TABLE "ScheduledDeletion" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "ScheduledDeletion" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);
ALTER TABLE "ScheduledDeletion" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);

ALTER TABLE "TrashItem" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "TrashItem" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);
ALTER TABLE "TrashItem" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);

ALTER TABLE "DriveItemMeta" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "DriveItemMeta" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);
ALTER TABLE "DriveItemMeta" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "DriveItemMeta" ALTER COLUMN "creatorId" TYPE UUID USING (md5("creatorId")::uuid);

ALTER TABLE "DockerConnection" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "DockerConnection" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);

ALTER TABLE "StorageMount" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "StorageMount" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);

ALTER TABLE "Node" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Node" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "Node" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);

ALTER TABLE "Share" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Share" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "Share" ALTER COLUMN "nodeId" TYPE UUID USING (md5("nodeId")::uuid);
ALTER TABLE "Share" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);

ALTER TABLE "ShareInvite" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "ShareInvite" ALTER COLUMN "shareId" TYPE UUID USING (md5("shareId")::uuid);
ALTER TABLE "ShareInvite" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "ShareAccessLog" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "ShareAccessLog" ALTER COLUMN "shareId" TYPE UUID USING (md5("shareId")::uuid);

ALTER TABLE "FileRequest" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "FileRequest" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);
ALTER TABLE "FileRequest" ALTER COLUMN "destinationConnectionId" TYPE UUID USING (md5("destinationConnectionId")::uuid);

ALTER TABLE "RateLimitCounter" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);

ALTER TABLE "FileRequestSubmission" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "FileRequestSubmission" ALTER COLUMN "requestId" TYPE UUID USING (md5("requestId")::uuid);
ALTER TABLE "FileRequestSubmission" ALTER COLUMN "submittedByUserId" TYPE UUID USING (md5("submittedByUserId")::uuid);
ALTER TABLE "FileRequestSubmission" ALTER COLUMN "storedNodeId" TYPE UUID USING (md5("storedNodeId")::uuid);

ALTER TABLE "UploadSession" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "UploadSession" ALTER COLUMN "ownerId" TYPE UUID USING (md5("ownerId")::uuid);
ALTER TABLE "UploadSession" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);
ALTER TABLE "UploadSession" ALTER COLUMN "fileRequestId" TYPE UUID USING (md5("fileRequestId")::uuid);

ALTER TABLE "AuditLog" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" TYPE UUID USING (md5("actorId")::uuid);
ALTER TABLE "AuditLog" ALTER COLUMN "targetId" TYPE UUID USING (md5("targetId")::uuid);

ALTER TABLE "Setting" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Setting" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "Integration" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Integration" ALTER COLUMN "installedById" TYPE UUID USING (md5("installedById")::uuid);

ALTER TABLE "Notification" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "Notification" ALTER COLUMN "userId" TYPE UUID USING (md5("userId")::uuid);

ALTER TABLE "FileScan" ALTER COLUMN "id" TYPE UUID USING (md5("id")::uuid);
ALTER TABLE "FileScan" ALTER COLUMN "submissionId" TYPE UUID USING (md5("submissionId")::uuid);
ALTER TABLE "FileScan" ALTER COLUMN "connectionId" TYPE UUID USING (md5("connectionId")::uuid);

-- 3. Re-add every foreign key now that both sides are uuid.
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyAttachment" ADD CONSTRAINT "PolicyAttachment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriveAcl" ADD CONSTRAINT "DriveAcl_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessLock" ADD CONSTRAINT "AccessLock_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorageConnection" ADD CONSTRAINT "StorageConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledDeletion" ADD CONSTRAINT "ScheduledDeletion_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrashItem" ADD CONSTRAINT "TrashItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriveItemMeta" ADD CONSTRAINT "DriveItemMeta_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DockerConnection" ADD CONSTRAINT "DockerConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorageMount" ADD CONSTRAINT "StorageMount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Node" ADD CONSTRAINT "Node_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Share" ADD CONSTRAINT "Share_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Share" ADD CONSTRAINT "Share_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Share" ADD CONSTRAINT "Share_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareInvite" ADD CONSTRAINT "ShareInvite_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareInvite" ADD CONSTRAINT "ShareInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareAccessLog" ADD CONSTRAINT "ShareAccessLog_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRequest" ADD CONSTRAINT "FileRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRequest" ADD CONSTRAINT "FileRequest_destinationConnectionId_fkey" FOREIGN KEY ("destinationConnectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRequestSubmission" ADD CONSTRAINT "FileRequestSubmission_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FileRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRequestSubmission" ADD CONSTRAINT "FileRequestSubmission_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FileRequestSubmission" ADD CONSTRAINT "FileRequestSubmission_storedNodeId_fkey" FOREIGN KEY ("storedNodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. New User ban columns (used by the admin "ban user" action).
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "banReason" TEXT;
