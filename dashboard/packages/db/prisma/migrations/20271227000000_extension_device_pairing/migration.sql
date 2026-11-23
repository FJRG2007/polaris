-- An extension connection proven to run on the same computer as Polaris
-- Desktop: the device key it was bound to, the id it has in its browser, and
-- the short-lived single-use nonces that pair it.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "ExtensionDevicePairing";
--             ALTER TABLE "ExtensionSession" DROP COLUMN "deviceKey", DROP COLUMN "runtimeId";
ALTER TABLE "ExtensionSession" ADD COLUMN IF NOT EXISTS "deviceKey" TEXT;
ALTER TABLE "ExtensionSession" ADD COLUMN IF NOT EXISTS "runtimeId" TEXT;

CREATE TABLE IF NOT EXISTS "ExtensionDevicePairing" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "extensionSessionId" UUID NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionDevicePairing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionDevicePairing_nonceHash_key" ON "ExtensionDevicePairing"("nonceHash");
CREATE INDEX IF NOT EXISTS "ExtensionDevicePairing_extensionSessionId_idx" ON "ExtensionDevicePairing"("extensionSessionId");
CREATE INDEX IF NOT EXISTS "ExtensionDevicePairing_expiresAt_idx" ON "ExtensionDevicePairing"("expiresAt");

ALTER TABLE "ExtensionDevicePairing" DROP CONSTRAINT IF EXISTS "ExtensionDevicePairing_extensionSessionId_fkey";
ALTER TABLE "ExtensionDevicePairing" ADD CONSTRAINT "ExtensionDevicePairing_extensionSessionId_fkey" FOREIGN KEY ("extensionSessionId") REFERENCES "ExtensionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
