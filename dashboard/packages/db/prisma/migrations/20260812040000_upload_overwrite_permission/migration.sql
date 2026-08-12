-- Uploads through a share link or a drop point keep the sender's filename and no
-- longer overwrite what is already in the destination folder. Replacing an
-- existing file becomes an explicit permission, off for everything that exists.

ALTER TABLE "Share" ADD COLUMN "allowOverwrite" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "FileRequest" ADD COLUMN "allowOverwrite" BOOLEAN NOT NULL DEFAULT false;
