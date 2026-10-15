-- Outbound webhooks: signed event deliveries to an account's own endpoints,
-- with a delivery log. Additive only. To reverse, drop the two tables.

CREATE TABLE IF NOT EXISTS "OutboundWebhook" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "urlHint" TEXT NOT NULL,
    "encryptedUrl" BYTEA NOT NULL,
    "urlNonce" BYTEA NOT NULL,
    "urlKeyId" TEXT,
    "encryptedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretKeyId" TEXT,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OutboundWebhook_userId_idx" ON "OutboundWebhook"("userId");

DO $$ BEGIN
    ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "OutboundWebhookDelivery" (
    "id" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboundWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OutboundWebhookDelivery_webhookId_createdAt_idx" ON "OutboundWebhookDelivery"("webhookId", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundWebhookDelivery_status_nextAttemptAt_idx" ON "OutboundWebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "OutboundWebhookDelivery_createdAt_idx" ON "OutboundWebhookDelivery"("createdAt");

DO $$ BEGIN
    ALTER TABLE "OutboundWebhookDelivery" ADD CONSTRAINT "OutboundWebhookDelivery_webhookId_fkey"
        FOREIGN KEY ("webhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
