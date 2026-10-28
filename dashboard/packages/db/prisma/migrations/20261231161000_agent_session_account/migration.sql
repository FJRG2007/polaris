-- The account a session signs in with. 20260901100000_session_account added it,
-- but on a fresh database that migration runs before the table exists (see its
-- guard), so this is where such a database gets the column.
--
-- Additive, and a no-op on every install that already has it.
-- To reverse: nothing - the column predates this migration everywhere else.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "accountId" UUID;
