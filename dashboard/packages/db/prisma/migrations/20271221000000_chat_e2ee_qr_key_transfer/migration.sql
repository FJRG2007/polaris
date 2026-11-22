-- Chat end-to-end encryption, phase 1: the QR sign-in carries the account key.
-- Additive and nullable: existing codes read as carrying nothing, and the
-- columns are written only while the internal rollout flag is on.
ALTER TABLE "DeviceCode" ADD COLUMN IF NOT EXISTS "e2eeOffer" BYTEA;
ALTER TABLE "DeviceCode" ADD COLUMN IF NOT EXISTS "e2eeApproval" TEXT;
