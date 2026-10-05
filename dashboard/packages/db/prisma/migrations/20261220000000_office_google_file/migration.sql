-- Where an Office document came from in Google Drive, and the copy it is saved
-- back to. A new table; nothing that exists changes.
--
-- Every statement is written so that running it a second time is a no-op.
--
-- To undo:
--   DROP TABLE IF EXISTS "OfficeGoogleFile";

-- CreateTable
CREATE TABLE IF NOT EXISTS "OfficeGoogleFile" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceMime" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "copyFileId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedAt" TIMESTAMP(3),

    CONSTRAINT "OfficeGoogleFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OfficeGoogleFile_documentId_key" ON "OfficeGoogleFile"("documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OfficeGoogleFile_connectionId_idx" ON "OfficeGoogleFile"("connectionId");

-- AddForeignKey
ALTER TABLE "OfficeGoogleFile" DROP CONSTRAINT IF EXISTS "OfficeGoogleFile_documentId_fkey";
ALTER TABLE "OfficeGoogleFile" ADD CONSTRAINT "OfficeGoogleFile_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OfficeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
