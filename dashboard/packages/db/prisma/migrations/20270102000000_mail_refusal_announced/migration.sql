ALTER TABLE "MailAccount" ADD COLUMN "refusalAnnouncedAt" TIMESTAMP(3);

UPDATE "MailAccount" SET "refusalAnnouncedAt" = CURRENT_TIMESTAMP WHERE "state" = 'auth';
