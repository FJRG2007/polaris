-- Where a message was when it went into the trash, so taking it out puts it back
-- there rather than in the inbox.
--
-- Keyed on the Message-Id header rather than on a message row: a move deletes
-- the row and the destination folder writes a new one on the next pass, so
-- anything recorded against the old row would go with it.
--
-- A new table and nothing else. Written to be safe to run twice: the entrypoint
-- retries migrations, and an update can kill the container part-way through one.
CREATE TABLE IF NOT EXISTS "MailTrashOrigin" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "folderId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailTrashOrigin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MailTrashOrigin_accountId_messageId_key"
    ON "MailTrashOrigin" ("accountId", "messageId");

CREATE INDEX IF NOT EXISTS "MailTrashOrigin_accountId_at_idx"
    ON "MailTrashOrigin" ("accountId", "at");

ALTER TABLE "MailTrashOrigin" DROP CONSTRAINT IF EXISTS "MailTrashOrigin_accountId_fkey";
ALTER TABLE "MailTrashOrigin"
    ADD CONSTRAINT "MailTrashOrigin_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "MailAccount" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MailTrashOrigin" DROP CONSTRAINT IF EXISTS "MailTrashOrigin_folderId_fkey";
ALTER TABLE "MailTrashOrigin"
    ADD CONSTRAINT "MailTrashOrigin_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "MailFolder" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
