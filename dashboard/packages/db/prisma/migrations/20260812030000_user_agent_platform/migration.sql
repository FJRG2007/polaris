-- The operating system a browser announced in `sec-ch-ua-platform`, recorded
-- beside the brands on every record that describes a device.
--
-- The user-agent cannot be trusted for this: a browser put into device-emulation
-- mode rewrites the string to a phone's and leaves the hints alone, so a Windows
-- laptop was being listed as an iPhone. Null on every row written before this,
-- which reads as "no hint" and falls back to the user-agent as before.
ALTER TABLE "SessionState" ADD COLUMN "userAgentPlatform" TEXT;
ALTER TABLE "TrustedDevice" ADD COLUMN "userAgentPlatform" TEXT;
ALTER TABLE "AccountDevice" ADD COLUMN "userAgentPlatform" TEXT;
ALTER TABLE "Passkey" ADD COLUMN "userAgentPlatform" TEXT;

-- The browser waiting on a sign-in code is described to whoever approves it, so
-- it is read like every other device record: the brands name a Chromium that
-- rebadges Chrome, and the platform outranks the user-agent's claim.
ALTER TABLE "DeviceCode" ADD COLUMN "requestUserAgentBrands" TEXT;
ALTER TABLE "DeviceCode" ADD COLUMN "requestUserAgentPlatform" TEXT;
