-- Whether devices' packets reach a VPN node's port, as last checked.
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "reachVerdict" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN IF NOT EXISTS "reachCheckedAt" TIMESTAMP(3);
