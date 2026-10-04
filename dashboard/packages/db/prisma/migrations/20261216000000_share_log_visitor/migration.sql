-- Who opened a shared link, when they were signed in.
--
-- `ShareAccessLog.userId` and `SnippetAccessLog.userId` name the Polaris account
-- the visitor's own session belonged to. Every row that exists already stays
-- null, which the access log shows as anonymous. Deleting the account clears the
-- reference and keeps the row.
--
-- Every statement is written so that running it a second time is a no-op.
--
-- To undo:
--   ALTER TABLE "ShareAccessLog" DROP CONSTRAINT IF EXISTS "ShareAccessLog_userId_fkey";
--   DROP INDEX IF EXISTS "ShareAccessLog_userId_idx";
--   ALTER TABLE "ShareAccessLog" DROP COLUMN IF EXISTS "userId";
--   ALTER TABLE "SnippetAccessLog" DROP CONSTRAINT IF EXISTS "SnippetAccessLog_userId_fkey";
--   DROP INDEX IF EXISTS "SnippetAccessLog_userId_idx";
--   ALTER TABLE "SnippetAccessLog" DROP COLUMN IF EXISTS "userId";

-- AlterTable
ALTER TABLE "ShareAccessLog" ADD COLUMN IF NOT EXISTS "userId" UUID;

-- AlterTable
ALTER TABLE "SnippetAccessLog" ADD COLUMN IF NOT EXISTS "userId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ShareAccessLog_userId_idx" ON "ShareAccessLog"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SnippetAccessLog_userId_idx" ON "SnippetAccessLog"("userId");

-- AddForeignKey
ALTER TABLE "ShareAccessLog" DROP CONSTRAINT IF EXISTS "ShareAccessLog_userId_fkey";
ALTER TABLE "ShareAccessLog" ADD CONSTRAINT "ShareAccessLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetAccessLog" DROP CONSTRAINT IF EXISTS "SnippetAccessLog_userId_fkey";
ALTER TABLE "SnippetAccessLog" ADD CONSTRAINT "SnippetAccessLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
