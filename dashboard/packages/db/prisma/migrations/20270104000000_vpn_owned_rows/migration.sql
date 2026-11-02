-- A node ends with its machine, and what a node or a person used ends with them.
DELETE FROM "VpnNode" WHERE "hostId" NOT IN (SELECT "id" FROM "Host");
DELETE FROM "VpnProxyUsage" WHERE "nodeId" NOT IN (SELECT "id" FROM "VpnNode");
DELETE FROM "VpnProxyUsage" WHERE "userId" NOT IN (SELECT "id" FROM "User");

CREATE INDEX IF NOT EXISTS "VpnProxyUsage_userId_idx" ON "VpnProxyUsage"("userId");

ALTER TABLE "VpnNode" DROP CONSTRAINT IF EXISTS "VpnNode_hostId_fkey";
ALTER TABLE "VpnNode" ADD CONSTRAINT "VpnNode_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VpnProxyUsage" DROP CONSTRAINT IF EXISTS "VpnProxyUsage_nodeId_fkey";
ALTER TABLE "VpnProxyUsage" ADD CONSTRAINT "VpnProxyUsage_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "VpnNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VpnProxyUsage" DROP CONSTRAINT IF EXISTS "VpnProxyUsage_userId_fkey";
ALTER TABLE "VpnProxyUsage" ADD CONSTRAINT "VpnProxyUsage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
