-- Tie each activity entry to the session it came from, so a user can read their
-- own history one device at a time. No foreign key on purpose: ending a session
-- must not erase the record of what was done from it, and rows written before
-- this column existed simply stay unattributed.
ALTER TABLE "AuditLog" ADD COLUMN "sessionId" UUID;

CREATE INDEX "AuditLog_sessionId_idx" ON "AuditLog"("sessionId");
