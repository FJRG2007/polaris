-- A firewall ban can be answered with the browser check instead of a refusal.
-- Additive: every existing ban stays a refusal.
-- AlterTable
ALTER TABLE "WafBan" ADD COLUMN IF NOT EXISTS "challenge" BOOLEAN NOT NULL DEFAULT false;
