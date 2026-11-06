-- Why a VPN server cannot carry browsers yet, and where it is placed on the map.
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "proxyIssue" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "placedBy" TEXT;
