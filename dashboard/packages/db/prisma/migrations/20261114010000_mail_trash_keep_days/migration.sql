-- How long a mailbox's trash holds on to what was thrown away, in days.
--
-- Thirty by default, which is what every mail service does and what anybody who
-- has used one expects. Zero means keep it until somebody empties it by hand -
-- the behaviour every Polaris mailbox had until now, so nothing is lost by the
-- column arriving; a mailbox that wants it is a mailbox whose owner said so.
--
-- One column and nothing else. Written to be safe to run twice: the entrypoint
-- retries migrations, and an update can kill the container part-way through one.
ALTER TABLE "MailAccount"
    ADD COLUMN IF NOT EXISTS "trashKeepDays" INTEGER NOT NULL DEFAULT 30;
