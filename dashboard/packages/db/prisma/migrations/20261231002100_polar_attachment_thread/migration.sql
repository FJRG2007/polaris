-- A Polar file belongs to the thread whose saved message first carried it, so
-- deleting the thread can delete it, and a file nothing ever sent can be swept.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarAttachment" ADD COLUMN IF NOT EXISTS "threadId" UUID;

CREATE INDEX IF NOT EXISTS "PolarAttachment_threadId_createdAt_idx" ON "PolarAttachment"("threadId", "createdAt");

ALTER TABLE "PolarAttachment" DROP CONSTRAINT IF EXISTS "PolarAttachment_threadId_fkey";
ALTER TABLE "PolarAttachment" ADD CONSTRAINT "PolarAttachment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PolarThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Files already sent before this column existed: the thread of a message that
-- carries them. Only rows still unlinked are touched, so a second run finds none.
UPDATE "PolarAttachment" AS a
SET "threadId" = m."threadId"
FROM "PolarMessage" AS m
JOIN "PolarThread" AS t ON t."id" = m."threadId"
WHERE a."threadId" IS NULL
  AND t."userId" = a."userId"
  AND m."parts"::text LIKE '%/api/polar/attachments/' || a."id"::text || '%';
