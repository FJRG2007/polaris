-- A mailbox lent at `respond` or above can be written from. Both columns are
-- additive: every existing mailbox keeps sending on behalf (no switch set) and
-- every existing draft is its holder's (no author). Reversed by dropping the
-- index and the two columns.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "delegateSendAs" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MailDraft" ADD COLUMN IF NOT EXISTS "authorId" UUID;
CREATE INDEX IF NOT EXISTS "MailDraft_accountId_authorId_updatedAt_idx" ON "MailDraft"("accountId", "authorId", "updatedAt");
