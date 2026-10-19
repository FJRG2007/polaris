-- Extra headers and a sign-in for signed webhooks. Additive: every column is
-- nullable, so an existing endpoint keeps sending exactly what it sent before.
-- Reversed by dropping the four columns.
ALTER TABLE "OutboundWebhook" ADD COLUMN IF NOT EXISTS "requestConfig" JSONB;
ALTER TABLE "OutboundWebhook" ADD COLUMN IF NOT EXISTS "encryptedRequest" BYTEA;
ALTER TABLE "OutboundWebhook" ADD COLUMN IF NOT EXISTS "requestNonce" BYTEA;
ALTER TABLE "OutboundWebhook" ADD COLUMN IF NOT EXISTS "requestKeyId" TEXT;
