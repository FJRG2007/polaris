-- The view-once sweep reads a bounded range of this index: files past their wait.
CREATE INDEX IF NOT EXISTS "ChatAttachment_viewOnce_createdAt_idx" ON "ChatAttachment"("viewOnce", "createdAt");
