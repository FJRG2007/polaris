-- Signing in by scanning a QR code.
--
-- The sign-in screen shows a code; a phone that is already signed in scans it,
-- is shown what is asking, and lets it in with the quick-unlock PIN. This table
-- is what carries that decision between the two devices.
--
-- Every column down to "scope" belongs to better-auth's device-authorization
-- plugin (RFC 8628) and is written only by it. The three "request" columns are
-- Polaris additions, filled in when the code is issued, so the person approving
-- is shown the device and the address that asked instead of approving something
-- unnamed.
--
-- Rows are short-lived: a code expires in minutes and is consumed by the
-- exchange that issues the session, so this table stays near-empty. The expiry
-- index is there for the sweep that clears whatever was never answered.

-- CreateTable
CREATE TABLE "DeviceCode" (
    "id" UUID NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "userId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "pollingInterval" INTEGER,
    "clientId" TEXT,
    "scope" TEXT,
    "requestIp" TEXT,
    "requestUserAgent" TEXT,
    "requestHost" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_deviceCode_key" ON "DeviceCode"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_userCode_key" ON "DeviceCode"("userCode");

-- CreateIndex
CREATE INDEX "DeviceCode_userId_idx" ON "DeviceCode"("userId");

-- CreateIndex
CREATE INDEX "DeviceCode_expiresAt_idx" ON "DeviceCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "DeviceCode" ADD CONSTRAINT "DeviceCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
