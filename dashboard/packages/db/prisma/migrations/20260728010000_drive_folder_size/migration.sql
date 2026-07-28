-- Measured size of a folder's subtree, kept so the Drive browser can show folder
-- weights without walking the remote tree on every listing. Derived data: rows
-- are dropped when Polaris writes under or above the path, and age out otherwise.
-- "partial" marks a walk that hit its budget, making "bytes" a lower bound.
CREATE TABLE "DriveFolderSize" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "files" INTEGER NOT NULL DEFAULT 0,
    "folders" INTEGER NOT NULL DEFAULT 0,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriveFolderSize_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriveFolderSize_connectionId_path_key" ON "DriveFolderSize"("connectionId", "path");

ALTER TABLE "DriveFolderSize" ADD CONSTRAINT "DriveFolderSize_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
