-- A mailbox lent at `respond` or above can be written from. Both columns are
-- additive: every existing mailbox keeps sending on behalf (no switch set) and
-- every existing draft is its holder's (no author). A delegate's drafts go with
-- their account. Reversed by dropping the constraint, the indexes and the two
-- columns.
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "delegateSendAs" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MailDraft" ADD COLUMN IF NOT EXISTS "authorId" UUID;
CREATE INDEX IF NOT EXISTS "MailDraft_accountId_authorId_updatedAt_idx" ON "MailDraft"("accountId", "authorId", "updatedAt");
CREATE INDEX IF NOT EXISTS "MailDraft_authorId_idx" ON "MailDraft"("authorId");
DELETE FROM "MailDraft" WHERE "authorId" IS NOT NULL AND "authorId" NOT IN (SELECT "id" FROM "User");
ALTER TABLE "MailDraft" DROP CONSTRAINT IF EXISTS "MailDraft_authorId_fkey";
ALTER TABLE "MailDraft" ADD CONSTRAINT "MailDraft_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
