-- Agent sessions: the machine-side sequence of the newest hook that moved a
-- session's state, so hook posts that overtake each other are applied in the
-- order they happened. Nullable, no backfill: a session with none applies
-- events as they arrive, which is what every session did before.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "lastEventSeq" BIGINT;
