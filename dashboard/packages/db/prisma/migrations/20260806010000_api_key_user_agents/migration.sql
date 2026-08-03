-- Which clients an API key answers to, beside which addresses.
--
-- A key could already say where it may be used from. That leaves the other half
-- unanswered: a key minted for one deployment script has no business being
-- replayed out of a browser, and a key that only ever runs from CI could not say
-- so. These two lists are that half.
--
-- Patterns rather than exact strings, because a user-agent carries a version
-- that moves. Deny is evaluated after allow and wins, so a pattern added to keep
-- something out keeps it out however the allow list is later widened.
--
-- Neither list is a boundary on its own - a user-agent is written by whoever
-- makes the request - which is why they narrow a credential that is already
-- proven rather than standing in for proving one.
--
-- Empty on every existing key, which means "any client": nothing that works
-- today stops working when this runs.

ALTER TABLE "ApiKey" ADD COLUMN "allowedUserAgents" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ApiKey" ADD COLUMN "deniedUserAgents" TEXT NOT NULL DEFAULT '[]';

-- And what last presented it. The key already recorded the address it was last
-- used from; on its own that dates a key without saying what is holding it.

ALTER TABLE "ApiKey" ADD COLUMN "lastUsedUserAgent" TEXT;
