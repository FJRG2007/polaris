-- A provider key can be switched off without being deleted. Additive only: the
-- column defaults to true, so every key stored before this keeps working.
--
-- Running it a second time is a no-op.

-- AlterTable
ALTER TABLE "UserModelKey" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
