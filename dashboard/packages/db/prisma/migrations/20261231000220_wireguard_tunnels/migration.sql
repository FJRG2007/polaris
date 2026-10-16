-- WireGuard tunnels: a service behind NAT published through a server with a
-- public address. Additive only.
CREATE TABLE "WireguardTunnel" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "publicTargetId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "listenPort" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeySealed" TEXT NOT NULL,
    "peerPublicKey" TEXT NOT NULL,
    "peerPrivateKeySealed" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WireguardTunnel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WireguardTunnel_publicTargetId_listenPort_key" ON "WireguardTunnel"("publicTargetId", "listenPort");
CREATE UNIQUE INDEX "WireguardTunnel_ownerId_slot_key" ON "WireguardTunnel"("ownerId", "slot");
CREATE UNIQUE INDEX "WireguardTunnel_hostname_key" ON "WireguardTunnel"("hostname");
CREATE INDEX "WireguardTunnel_applicationId_idx" ON "WireguardTunnel"("applicationId");

ALTER TABLE "WireguardTunnel" ADD CONSTRAINT "WireguardTunnel_publicTargetId_fkey" FOREIGN KEY ("publicTargetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WireguardTunnel" ADD CONSTRAINT "WireguardTunnel_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
