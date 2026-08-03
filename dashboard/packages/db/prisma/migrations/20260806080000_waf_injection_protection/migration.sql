-- Refuse a request whose own URL carries a SQL injection or XSS payload.
--
-- Defaults true, which is what arms it on an existing instance with no backfill, and
-- what makes an upgrade safe to do that with: unlike the browser integrity check next
-- to it, this matches strings that cannot occur in an honest request line rather than
-- guessing at what a client is. Scopes intersect on it, so a row picking up the
-- default here cannot re-arm it anywhere an operator later turns it off.
ALTER TABLE "WafRule" ADD COLUMN "injectionProtection" BOOLEAN NOT NULL DEFAULT true;
