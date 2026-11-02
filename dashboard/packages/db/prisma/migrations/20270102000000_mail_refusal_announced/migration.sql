ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "refusalAnnouncedAt" TIMESTAMP(3);

UPDATE "MailAccount" SET "refusalAnnouncedAt" = CURRENT_TIMESTAMP WHERE "state" = 'auth' AND "refusalAnnouncedAt" IS NULL;
