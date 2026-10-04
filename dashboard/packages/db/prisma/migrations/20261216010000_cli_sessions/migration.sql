-- A CLI sign-in listed as a session.
--
-- The columns a session row shows for one: the computer, its system and the
-- CLI's version as reported at sign-in, the address it was approved from, and
-- its own answer to the address lock. Null on every key that already exists,
-- which is right: none of them is a CLI sign-in with that information.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientName" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientOs" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientVersion" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "signedInIp" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "pinToAddress" BOOLEAN;

-- The sessions screen lists an account's live CLI sign-ins by owner and kind.
CREATE INDEX IF NOT EXISTS "ApiKey_userId_kind_idx" ON "ApiKey"("userId", "kind");
