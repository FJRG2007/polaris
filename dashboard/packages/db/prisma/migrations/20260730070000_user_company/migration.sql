-- The organisation a user belongs to, edited from their own profile. Free text
-- and optional: it labels the account, nothing reads it to decide anything.
ALTER TABLE "User" ADD COLUMN "company" TEXT;
