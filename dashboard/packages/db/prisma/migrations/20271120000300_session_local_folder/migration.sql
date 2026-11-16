-- A folder on the runner's own computer a Code session works in (computer-sessions.ts).
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "localFolder" TEXT NOT NULL DEFAULT '';
