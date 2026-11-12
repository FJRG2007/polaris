-- Ask for the passkey automatically when this browser has used it before.
-- Additive: on for every existing account, which is the new default.
-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "autoPasskey" BOOLEAN NOT NULL DEFAULT true;
