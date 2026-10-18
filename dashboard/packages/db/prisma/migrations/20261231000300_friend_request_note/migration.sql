-- AlterTable
ALTER TABLE "Friendship" ADD COLUMN "note" VARCHAR(300);

-- CreateIndex
CREATE INDEX "Notification_type_actionRequired_id_idx" ON "Notification"("type", "actionRequired", "id");
