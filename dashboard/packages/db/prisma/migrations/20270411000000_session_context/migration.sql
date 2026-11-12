-- The size of an agent session's conversation at its last turn, for the
-- context bar in Polar's Code. Nullable and additive: every existing session
-- reads as "not known yet" until its next turn is read.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "contextTokens" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "contextModel" TEXT;
