-- AlterTable
ALTER TABLE "Friendship" ADD COLUMN IF NOT EXISTS "note" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_type_actionRequired_id_idx" ON "Notification"("type", "actionRequired", "id");
