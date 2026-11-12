-- The apps an account keeps behind its PIN, and which of them this session has
-- unlocked (app id -> last activity in epoch milliseconds).
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "lockedApps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SessionState" ADD COLUMN IF NOT EXISTS "appUnlocks" JSONB NOT NULL DEFAULT '{}';
