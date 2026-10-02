-- Where a share link led.
--
-- `LinkPreview.target` is the address a share-button short link (`vm.tiktok.com`,
-- `spotify.link`, Reddit's `/s/` links) redirected to, kept without the sharer's
-- query, so the chat can put a player in for it. Every row that exists already is
-- null, which the unfurl reads as "not followed yet" and repairs within the hour.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "LinkPreview" ADD COLUMN IF NOT EXISTS "target" TEXT;
