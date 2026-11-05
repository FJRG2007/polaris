-- Agent sessions: when the silence sweep last found a session's terminal alive.
-- Nullable, no backfill: a session with none is probed the first time it is
-- quiet for long enough, which is the earliest anything could know.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "lastAliveAt" TIMESTAMP(3);
