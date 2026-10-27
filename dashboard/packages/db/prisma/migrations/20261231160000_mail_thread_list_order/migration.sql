-- A mail list is read pinned first, then by its latest message, with the id
-- breaking a tie, and the next page is "unpinned and past this moment and row".
-- The only index on the order was (accountId, lastMessageAt), which cannot give
-- a pinned-first order, so every page sorted all of a mailbox's conversations
-- before it could return the first fifty.
--
-- Additive: one index, nothing removed. IF NOT EXISTS makes a rerun a no-op.
-- To reverse: DROP INDEX "MailThread_accountId_pinned_lastMessageAt_id_idx".
CREATE INDEX IF NOT EXISTS "MailThread_accountId_pinned_lastMessageAt_id_idx" ON "MailThread"("accountId", "pinned", "lastMessageAt", "id");
