-- What a link of a known kind adds to its card: for a Steam store link, the
-- price, the release and the systems it runs on, as JSON text. Null on every row
-- that already exists, which draws the ordinary card until the link is looked
-- at again.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- column.

ALTER TABLE "LinkPreview" ADD COLUMN IF NOT EXISTS "details" TEXT;
