-- Inbound webhooks: signed URLs that redeploy one service, and the delivery ids
-- already accepted (kept until they could no longer pass, against replays).
-- Additive only. To reverse, drop the two tables.

CREATE TABLE IF NOT EXISTS "InboundWebhook" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundWebhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InboundWebhook_userId_idx" ON "InboundWebhook"("userId");
CREATE INDEX IF NOT EXISTS "InboundWebhook_applicationId_idx" ON "InboundWebhook"("applicationId");

ALTER TABLE "InboundWebhook" DROP CONSTRAINT IF EXISTS "InboundWebhook_userId_fkey";
ALTER TABLE "InboundWebhook" ADD CONSTRAINT "InboundWebhook_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboundWebhook" DROP CONSTRAINT IF EXISTS "InboundWebhook_applicationId_fkey";
ALTER TABLE "InboundWebhook" ADD CONSTRAINT "InboundWebhook_applicationId_fkey"
        FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "InboundWebhookReceipt" (
    "id" UUID NOT NULL,
    "hookId" UUID NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboundWebhookReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InboundWebhookReceipt_hookId_deliveryId_key" ON "InboundWebhookReceipt"("hookId", "deliveryId");
CREATE INDEX IF NOT EXISTS "InboundWebhookReceipt_expiresAt_idx" ON "InboundWebhookReceipt"("expiresAt");

ALTER TABLE "InboundWebhookReceipt" DROP CONSTRAINT IF EXISTS "InboundWebhookReceipt_hookId_fkey";
ALTER TABLE "InboundWebhookReceipt" ADD CONSTRAINT "InboundWebhookReceipt_hookId_fkey"
        FOREIGN KEY ("hookId") REFERENCES "InboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
