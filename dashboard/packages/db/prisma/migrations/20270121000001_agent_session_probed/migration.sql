-- Agent sessions: when the silence sweep last probed a session, whatever it
-- answered. Nullable, no backfill: a session with none is probed the next time
-- it is quiet for long enough.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "lastProbedAt" TIMESTAMP(3);
