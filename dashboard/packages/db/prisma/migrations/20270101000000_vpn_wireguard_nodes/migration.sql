-- CreateTable
CREATE TABLE IF NOT EXISTS "VpnNode" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 51820,
    "exit" TEXT NOT NULL DEFAULT 'direct',
    "publicKey" TEXT,
    "subnetIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VpnNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VpnPeer" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "hostIndex" INTEGER NOT NULL,
    "received" BIGINT NOT NULL DEFAULT 0,
    "sent" BIGINT NOT NULL DEFAULT 0,
    "seenReceived" BIGINT NOT NULL DEFAULT 0,
    "seenSent" BIGINT NOT NULL DEFAULT 0,
    "lastHandshake" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VpnPeer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VpnAccess" (
    "userId" UUID NOT NULL,
    "nodes" UUID[],
    "deviceLimit" INTEGER NOT NULL DEFAULT 5,
    "dataLimitGb" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VpnAccess_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VpnNode_hostId_key" ON "VpnNode"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VpnNode_subnetIndex_key" ON "VpnNode"("subnetIndex");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VpnPeer_publicKey_key" ON "VpnPeer"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VpnPeer_nodeId_hostIndex_key" ON "VpnPeer"("nodeId", "hostIndex");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VpnPeer_userId_createdAt_idx" ON "VpnPeer"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "VpnPeer" DROP CONSTRAINT IF EXISTS "VpnPeer_nodeId_fkey";
ALTER TABLE "VpnPeer" ADD CONSTRAINT "VpnPeer_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "VpnNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VpnPeer" DROP CONSTRAINT IF EXISTS "VpnPeer_userId_fkey";
ALTER TABLE "VpnPeer" ADD CONSTRAINT "VpnPeer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VpnAccess" DROP CONSTRAINT IF EXISTS "VpnAccess_userId_fkey";
ALTER TABLE "VpnAccess" ADD CONSTRAINT "VpnAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
