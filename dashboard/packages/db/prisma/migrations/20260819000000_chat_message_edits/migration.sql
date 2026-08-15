-- CreateTable
CREATE TABLE "ChatMessageEdit" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessageEdit_messageId_replacedAt_idx" ON "ChatMessageEdit"("messageId", "replacedAt");

-- AddForeignKey
ALTER TABLE "ChatMessageEdit" ADD CONSTRAINT "ChatMessageEdit_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

