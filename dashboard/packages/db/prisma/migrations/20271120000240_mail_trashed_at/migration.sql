-- When a message entered the trash (apps/web/src/lib/mailbox/trash.ts sweepTrash):
-- the auto-empty counts from it rather than from the date the message arrived,
-- which a move keeps. What is already in a trash counts from now, so nothing is
-- destroyed before a full period has passed under the new rule.
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "trashedAt" TIMESTAMP(3);

UPDATE "MailMessage" m
SET "trashedAt" = now()
FROM "MailFolder" f
WHERE f.id = m."folderId" AND f.role = 'trash' AND m."trashedAt" IS NULL;
