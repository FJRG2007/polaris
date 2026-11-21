-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "clientKey" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_authorId_clientKey_key" ON "ChatMessage"("authorId", "clientKey");
