-- Pictures are shown by default.
--
-- They were held back behind a "Show pictures" button, which meant clicking
-- before you could read your own mail - something neither Gmail nor Proton asks
-- for, and which turned every newsletter into a chore.
--
-- It is safe to change because what is drawn no longer comes from the sender's
-- server: every outside address in a message is fetched by Polaris and served
-- from here, so a tracking pixel sees a request from this machine and learns
-- nothing about the reader.
--
-- Mailboxes that were left on the old default move with it, because that default
-- was never a choice anybody made. A mailbox whose owner deliberately chose to
-- block everything keeps blocking.
UPDATE "MailAccount" SET "remoteContent" = 'always' WHERE "remoteContent" = 'trusted';
ALTER TABLE "MailAccount" ALTER COLUMN "remoteContent" SET DEFAULT 'always';
