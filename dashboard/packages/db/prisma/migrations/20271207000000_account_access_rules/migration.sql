-- An account's own access rules, written like firewall custom rules, and two
-- markers: when an account's old sign-in allowlist was carried into them, and when
-- a passkey's origin was filled in on use rather than recorded when it was added.
--
-- Additive only. The old allowlist columns stay as they are; the move into the new
-- table happens once per account in the application (it has to create a saved list
-- holding the account's inline entries), guarded by "accessRulesMigratedAt".
-- Written to be safe to run twice.
CREATE TABLE IF NOT EXISTS "AccountAccessRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "action" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountAccessRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AccountAccessRule_userId_position_idx" ON "AccountAccessRule"("userId", "position");

ALTER TABLE "AccountAccessRule" DROP CONSTRAINT IF EXISTS "AccountAccessRule_userId_fkey";
ALTER TABLE "AccountAccessRule" ADD CONSTRAINT "AccountAccessRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "accessRulesMigratedAt" TIMESTAMP(3);

ALTER TABLE "Passkey" ADD COLUMN IF NOT EXISTS "originSeenAt" TIMESTAMP(3);
