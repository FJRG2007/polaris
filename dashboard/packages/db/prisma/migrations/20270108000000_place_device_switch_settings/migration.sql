-- Wall switches and sockets in Places: their settings, and how they are reached.
--
-- What a switch or a socket reports beside on and off - its power-on state,
-- indicator light, child lock and timer - is one document on the device row,
-- read and written whole like a litter box's. Beside it, whether the device was
-- last read on the local network or through its maker's cloud, as one word.
--
-- Both are nullable and start empty: the next read fills them in. Every
-- statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "switchSettings" JSONB;
ALTER TABLE "PlaceDevice" ADD COLUMN IF NOT EXISTS "reach" TEXT;
