-- Devices on the LAN outlive an address change: a camera remembers the
-- hardware address it answered as, so it can be found again when the network
-- hands it another IP, and a server remembers when it stopped answering, so
-- the screen can say since when. Additive: two nullable columns.
--
-- Running it a second time is a no-op.
-- To reverse: ALTER TABLE "Camera" DROP COLUMN "hardwareAddress";
-- ALTER TABLE "Host" DROP COLUMN "offlineSince".
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "hardwareAddress" TEXT;
ALTER TABLE "Host" ADD COLUMN IF NOT EXISTS "offlineSince" TIMESTAMP(3);
