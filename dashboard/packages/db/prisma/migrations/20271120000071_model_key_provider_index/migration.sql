-- Keys by provider: the AI providers screen counts the keys an operator-added
-- provider holds before it may be removed.
CREATE INDEX IF NOT EXISTS "UserModelKey_provider_idx" ON "UserModelKey"("provider");
