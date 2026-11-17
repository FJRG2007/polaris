-- Polar Code small items: a repository's standing instructions for its
-- sessions (apps/web/src/lib/agents/session-cues.ts). Rerunnable.
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "cues" TEXT NOT NULL DEFAULT '';

-- The command that starts a repository's dev server for the session preview
-- (apps/web/src/lib/agents/session-preview-command.ts).
ALTER TABLE "AgentRepo" ADD COLUMN IF NOT EXISTS "previewCommand" TEXT NOT NULL DEFAULT '';
