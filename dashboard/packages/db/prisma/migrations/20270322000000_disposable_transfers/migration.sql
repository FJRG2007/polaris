-- Disposable transfers: files shared by link or sent to people, deleted on
-- their own once they expire or run out of downloads. Two new tables, nothing
-- existing is touched. Running it twice is a no-op. To reverse: drop
-- "DisposableFile", then "DisposableTransfer".
CREATE TABLE IF NOT EXISTS "DisposableTransfer" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxDownloads" INTEGER,
    "totalSize" BIGINT NOT NULL DEFAULT 0,
    "readyAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisposableTransfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DisposableFile" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" BIGINT NOT NULL DEFAULT 0,
    "path" TEXT NOT NULL,
    "maxDownloads" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisposableFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DisposableTransfer_token_key" ON "DisposableTransfer"("token");
CREATE INDEX IF NOT EXISTS "DisposableTransfer_ownerId_createdAt_idx" ON "DisposableTransfer"("ownerId", "createdAt");
CREATE INDEX IF NOT EXISTS "DisposableTransfer_expiresAt_idx" ON "DisposableTransfer"("expiresAt");
CREATE INDEX IF NOT EXISTS "DisposableFile_transferId_idx" ON "DisposableFile"("transferId");

-- AddForeignKey
ALTER TABLE "DisposableTransfer" DROP CONSTRAINT IF EXISTS "DisposableTransfer_ownerId_fkey";
ALTER TABLE "DisposableTransfer" ADD CONSTRAINT "DisposableTransfer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisposableFile" DROP CONSTRAINT IF EXISTS "DisposableFile_transferId_fkey";
ALTER TABLE "DisposableFile" ADD CONSTRAINT "DisposableFile_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "DisposableTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
