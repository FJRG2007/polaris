-- Condition-keyed notices: additive. Existing rows keep a null key and a null
-- updatedAt, which is exactly what a one-off alert has.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "conditionKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_conditionKey_key" ON "Notification"("userId", "conditionKey");
