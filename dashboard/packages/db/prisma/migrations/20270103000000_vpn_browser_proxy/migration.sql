-- The browser extension's way in.
ALTER TABLE "VpnNode" ADD COLUMN "proxyKeySealed" BYTEA;
ALTER TABLE "VpnNode" ADD COLUMN "proxyKeyNonce" BYTEA;
ALTER TABLE "VpnNode" ADD COLUMN "proxyKeyId" TEXT;
ALTER TABLE "VpnNode" ADD COLUMN "proxyHost" TEXT;

CREATE TABLE "VpnProxyUsage" (
    "nodeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seen" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "VpnProxyUsage_pkey" PRIMARY KEY ("nodeId","userId")
);
