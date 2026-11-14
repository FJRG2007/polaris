-- The agent's todo list, and what a question or plan put to the person carries.
ALTER TABLE "AgentSession" ADD COLUMN IF NOT EXISTS "todos" JSONB;
ALTER TABLE "AgentPermissionRequest" ADD COLUMN IF NOT EXISTS "input" JSONB;
ALTER TABLE "AgentPermissionRequest" ADD COLUMN IF NOT EXISTS "answer" JSONB;
