-- Files on a message, and messages somebody kept.
--
-- ChatAttachment gains the storage connection it was written to, recorded per
-- file rather than read from the setting: pointing chat at a NAS next month must
-- not break every file already written somewhere else. Nullable, and null means
-- the disk Polaris runs on - which is also what every row written before this
-- would have meant, so the column needs no backfill.
--
-- ChatStar is private to the person who starred it. Starring is a bookmark, not
-- a signal to the room; a public one would turn "come back to this" into a
-- statement about somebody else message. Reactions are the public version.

-- AlterTable
ALTER TABLE "ChatAttachment" ADD COLUMN     "connectionId" UUID;

-- CreateTable
CREATE TABLE "ChatStar" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatStar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatStar_userId_createdAt_idx" ON "ChatStar"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatStar_messageId_userId_key" ON "ChatStar"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "ChatStar" ADD CONSTRAINT "ChatStar_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

