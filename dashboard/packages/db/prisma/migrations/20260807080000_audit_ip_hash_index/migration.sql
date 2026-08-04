-- Find what was done from one address.
--
-- The firewall can say what an address asked for, but not who it was. The activity
-- log holds that - it records the address behind every action, hashed - and the only
-- way to read it back is to hash the address being asked about and match. Every such
-- question was a scan of the whole log, which is the one table in Polaris that grows
-- with every action anybody takes.
CREATE INDEX "AuditLog_ipHash_idx" ON "AuditLog"("ipHash");
