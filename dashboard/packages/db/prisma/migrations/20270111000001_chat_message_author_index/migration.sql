-- The badge message count reads chat by author. Built concurrently so chat keeps
-- taking messages while a large table is indexed; that only works as the one
-- statement of its migration, outside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_authorId_idx" ON "ChatMessage"("authorId");
