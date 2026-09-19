-- Whether a browser extension's connection is tied to the address it was last
-- seen at. Null for every existing connection, which follows the account's own
-- rule for sessions.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ExtensionSession" ADD COLUMN IF NOT EXISTS "pinToAddress" BOOLEAN;
