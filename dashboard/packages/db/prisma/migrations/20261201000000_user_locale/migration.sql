-- The language an account reads Polaris in. Nullable: an account that has not
-- been seen since this arrived has one detected on its next request.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT;
