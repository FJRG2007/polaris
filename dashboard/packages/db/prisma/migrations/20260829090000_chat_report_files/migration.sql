-- A file that was on a message when somebody reported it.
--
-- The queue showed the text and nothing else, which for the commonest kind of
-- report - a picture - meant the one thing a moderator had to look at was the
-- one thing that was not there.
--
-- These rows point at the same stored file the message points at: nothing is
-- copied, so a conversation full of pictures does not cost twice as much
-- because one of them was objected to. `held` is what changes when the message
-- is deleted: the file is moved out from under it into the report's own folder,
-- and these columns are rewritten to say so. Still one copy of the bytes.
--
-- Every field is duplicated rather than read through `attachmentId` because the
-- attachment row goes with the message, and the report has to be able to draw
-- and serve the file after that.

-- CreateTable
CREATE TABLE "ChatReportFile" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "attachmentId" UUID,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL,
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "durationMs" INTEGER,
    "waveform" TEXT,
    "held" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReportFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatReportFile_reportId_idx" ON "ChatReportFile"("reportId");

-- The lookup that runs on every message deletion, so it must not be a scan.
-- CreateIndex
CREATE INDEX "ChatReportFile_attachmentId_idx" ON "ChatReportFile"("attachmentId");

-- AddForeignKey
ALTER TABLE "ChatReportFile" ADD CONSTRAINT "ChatReportFile_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ChatReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
