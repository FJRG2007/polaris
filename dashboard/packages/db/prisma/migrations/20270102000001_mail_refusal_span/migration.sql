ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "refusedSince" TIMESTAMP(3);
ALTER TABLE "MailAccount" ADD COLUMN IF NOT EXISTS "lastRefusedAt" TIMESTAMP(3);

UPDATE "MailAccount"
SET "refusedSince" = COALESCE("lastOkAt", "createdAt"),
    "lastRefusedAt" = COALESCE("lastSyncAt", CURRENT_TIMESTAMP)
WHERE "state" = 'auth' AND "refusedSince" IS NULL;
