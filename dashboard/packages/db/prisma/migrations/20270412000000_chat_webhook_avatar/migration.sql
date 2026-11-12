-- A webhook's own picture, and the picture one webhook message asked to post
-- under. Additive: existing webhooks have none and draw the webhook mark.
CREATE TABLE IF NOT EXISTS "ChatWebhookAvatar" (
    "webhookId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatWebhookAvatar_pkey" PRIMARY KEY ("webhookId")
);

DO $$ BEGIN
    ALTER TABLE "ChatWebhookAvatar" ADD CONSTRAINT "ChatWebhookAvatar_webhookId_fkey"
        FOREIGN KEY ("webhookId") REFERENCES "ChatWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "authorAvatarUrl" TEXT;
