-- A concurrent build that is interrupted leaves its index behind marked invalid,
-- and the retry of the migration before this one then skips it as existing. An
-- invalid index is never used, so it is built again here, in place.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'ChatMessage_authorId_idx' AND NOT i.indisvalid
    ) THEN
        DROP INDEX IF EXISTS "ChatMessage_authorId_idx";
        CREATE INDEX IF NOT EXISTS "ChatMessage_authorId_idx" ON "ChatMessage"("authorId");
    END IF;
END $$;
