-- The spam restriction counts the reports naming an account each time that
-- account starts a conversation, so those reads need an index of their own.
--
-- Additive only. Written so that running it a second time is a no-op.

CREATE INDEX IF NOT EXISTS "ChatReport_authorId_createdAt_idx" ON "ChatReport"("authorId", "createdAt");
