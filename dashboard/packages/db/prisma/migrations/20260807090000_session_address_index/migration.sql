-- Find the sessions held at one address.
--
-- The firewall asks which accounts an address has been seen on, and a session
-- answers from two columns: the one better-auth writes when the session opens,
-- and Polaris's own, re-stamped whenever the session is evaluated from somewhere
-- new. Neither was indexed, so every such question scanned every session open on
-- the instance and then its state row for each.
CREATE INDEX "Session_ipAddress_idx" ON "Session"("ipAddress");
CREATE INDEX "SessionState_ip_idx" ON "SessionState"("ip");
