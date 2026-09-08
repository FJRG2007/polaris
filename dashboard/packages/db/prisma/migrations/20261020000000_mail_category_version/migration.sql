-- Which set of rules decided a message's category.
--
-- The category was decided once, when the message arrived, and never again - so
-- every rule added afterwards applied to mail that had not arrived yet and to
-- nothing else. A notice that a subscription trial was ending sat under the
-- wrong tab permanently, because it was filed before "trial ends" was a phrase
-- Polaris knew.
--
-- Zero on every existing row, which puts all of them behind the current version
-- and back into the pass that fills empty ones. It runs in batches of five
-- hundred a minute and stops the moment there is nothing left, so a large
-- mailbox is re-sorted over a few hours with nothing fetched and nobody asked
-- to resync.
ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "categoryVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "MailMessage_categoryVersion_sentAt_idx"
    ON "MailMessage"("categoryVersion", "sentAt");
