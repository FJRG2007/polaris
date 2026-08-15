-- Pictures somebody kept, so they can send them again.
--
-- One row per person per thing: keeping something is a fact about a reader, not
-- about the message it was seen in, so the message can be deleted and the
-- channel left and what was kept stays kept.
--
-- `source` is either an http address, for a picture posted as a link, or
-- `attachment:<id>` for one already stored here. One column with a prefix rather
-- than two nullable ones - a pair of columns where exactly one must be set is a
-- pair that can be wrong.

-- CreateTable
CREATE TABLE "ChatSavedMedia" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSavedMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSavedMedia_userId_createdAt_idx" ON "ChatSavedMedia"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSavedMedia_userId_source_key" ON "ChatSavedMedia"("userId", "source");

-- AddForeignKey
ALTER TABLE "ChatSavedMedia" ADD CONSTRAINT "ChatSavedMedia_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
