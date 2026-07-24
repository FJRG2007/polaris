-- Granular write permissions for a share, each independent so a link can act as a
-- drop box and/or grant specific edits (rename, delete, create folder) without the
-- others. All default false so existing shares stay read-only until the owner opts
-- in - a share never gains a write capability from this migration.
ALTER TABLE "Share" ADD COLUMN "allowRename" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Share" ADD COLUMN "allowDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Share" ADD COLUMN "allowCreateFolder" BOOLEAN NOT NULL DEFAULT false;
