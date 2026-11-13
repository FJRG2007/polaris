-- A website form trigger keeps the fields each post sent, and whether it read as spam.
ALTER TABLE "AutomationHookDelivery" ADD COLUMN IF NOT EXISTS "fields" JSONB;
ALTER TABLE "AutomationHookDelivery" ADD COLUMN IF NOT EXISTS "spam" BOOLEAN NOT NULL DEFAULT false;
