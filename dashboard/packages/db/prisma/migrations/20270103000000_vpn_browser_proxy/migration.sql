-- The browser extension's way in.
ALTER TABLE "VpnNode" ADD COLUMN "encryptedProxyKey" BYTEA;
ALTER TABLE "VpnNode" ADD COLUMN "proxyKeyNonce" BYTEA;
ALTER TABLE "VpnNode" ADD COLUMN "proxyKeyId" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN "proxyHost" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN "country" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN "city" TEXT;

CREATE TABLE "VpnProxyUsage" (
    "nodeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seen" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "VpnProxyUsage_pkey" PRIMARY KEY ("nodeId","userId")
);

-- A VPN a person brought with them.
CREATE TABLE "VpnProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedConfig" BYTEA NOT NULL,
    "configNonce" BYTEA NOT NULL,
    "configKeyId" TEXT NOT NULL,
    "country" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VpnProfile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VpnProfile_userId_name_idx" ON "VpnProfile"("userId", "name");

ALTER TABLE "VpnProfile" ADD CONSTRAINT "VpnProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
