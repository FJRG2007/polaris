-- AlterTable
-- Guarded: the table is created by 20260929090000_agent_sessions, which was
-- committed before this one under a later name. Installs that took them in that
-- order have the table here; a fresh database runs this first and has not, and
-- gets the column from 20261231161000_agent_session_account instead.
DO $$
BEGIN
    IF to_regclass('"AgentSession"') IS NOT NULL THEN
        ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "accountId" UUID;
    END IF;
END $$;
