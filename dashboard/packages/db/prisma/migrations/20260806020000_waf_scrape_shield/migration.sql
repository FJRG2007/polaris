-- Two scope-level firewall controls that are not custom rules.
--
-- browserIntegrity defaults false: it refuses traffic on a header heuristic, and
-- turning it on for every existing scope in a migration would start blocking API
-- clients and health checks on upgrade.
--
-- emailObfuscation defaults true, which is what makes it on everywhere without a
-- backfill: it rewrites served HTML rather than refusing anything, and scopes
-- intersect on it, so an existing row picking up the default cannot re-enable it
-- anywhere an operator later turns it off.
ALTER TABLE "WafRule" ADD COLUMN "browserIntegrity" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WafRule" ADD COLUMN "emailObfuscation" BOOLEAN NOT NULL DEFAULT true;
