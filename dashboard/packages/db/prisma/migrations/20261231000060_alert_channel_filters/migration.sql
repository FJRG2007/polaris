-- Alert channels: a lowest severity per destination, and quiet hours per
-- account. Additive only, with defaults that keep every existing destination
-- sending what it sent before. To reverse, drop the two columns.

ALTER TABLE "NotificationDestination" ADD COLUMN IF NOT EXISTS "minLevel" TEXT NOT NULL DEFAULT 'info';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyQuietHours" TEXT;
