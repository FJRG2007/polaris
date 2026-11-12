-- The quick PIN's length, so a prompt can check it as the last digit lands.
-- Additive and idempotent; existing PINs fill it in on their next unlock.
-- To reverse: drop the pinLength column of UserSecurity.

ALTER TABLE "UserSecurity" ADD COLUMN IF NOT EXISTS "pinLength" INTEGER;
