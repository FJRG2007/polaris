-- Advanced drop-point limits: per-file minimum size, an extension blocklist, and
-- an allowlist of specific uploader identities (email/username). JSON columns
-- mirror the existing allow-list columns and default to empty.
ALTER TABLE "FileRequest" ADD COLUMN "minSizeBytes" BIGINT;
ALTER TABLE "FileRequest" ADD COLUMN "deniedExtensions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "FileRequest" ADD COLUMN "allowedUsers" TEXT NOT NULL DEFAULT '[]';
