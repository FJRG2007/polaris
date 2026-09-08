-- What an upload is for.
--
-- An attachment and an archive have ceilings an order of magnitude apart - a
-- mail server will not take 200 MB and an mbox routinely is - and until now the
-- request that stored the file chose which ceiling applied. Asking for the
-- archive ceiling and then attaching the file to a message was the attachment
-- limit, gone round. The kind is recorded here instead, and the attach path
-- matches on it.
ALTER TABLE "MailUpload" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'attachment';
