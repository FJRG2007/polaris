-- Several phone numbers per account. Additive: the existing row keeps its
-- number, its confirmation and any outstanding code, gains an id of its own,
-- and becomes the account's primary.
--
-- Every statement is written so that running it a second time is a no-op.
--
-- To reverse it (one row per account again), keep the primary of each account:
--   DELETE FROM "UserPhone" WHERE NOT "primary";
--   DROP INDEX IF EXISTS "UserPhone_userId_primary_key";
--   DROP INDEX IF EXISTS "UserPhone_userId_phone_key";
--   DROP INDEX IF EXISTS "UserPhone_phone_idx";
--   ALTER TABLE "UserPhone" DROP CONSTRAINT IF EXISTS "UserPhone_pkey";
--   ALTER TABLE "UserPhone" ADD CONSTRAINT "UserPhone_pkey" PRIMARY KEY ("userId");
--   ALTER TABLE "UserPhone" DROP COLUMN IF EXISTS "primary", DROP COLUMN IF EXISTS "id";

-- AlterTable
ALTER TABLE "UserPhone" ADD COLUMN IF NOT EXISTS "id" UUID;
ALTER TABLE "UserPhone" ADD COLUMN IF NOT EXISTS "primary" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: an id for every row that has none yet.
UPDATE "UserPhone" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "UserPhone" ALTER COLUMN "id" SET NOT NULL;

-- Backfill: the number an account already has is its primary. Until this
-- migration the user id was the key, so there is one row per account; the
-- DISTINCT ON still picks a single row per account, and an account that
-- already has a primary is skipped, so a second run changes nothing.
UPDATE "UserPhone" SET "primary" = true
WHERE "id" IN (
    SELECT DISTINCT ON ("userId") "id" FROM "UserPhone"
    ORDER BY "userId", "verifiedAt" ASC NULLS LAST, "createdAt" ASC
)
AND NOT EXISTS (
    SELECT 1 FROM "UserPhone" AS "held" WHERE "held"."userId" = "UserPhone"."userId" AND "held"."primary"
);

-- The key moves from the account to the row.
ALTER TABLE "UserPhone" DROP CONSTRAINT IF EXISTS "UserPhone_pkey";
ALTER TABLE "UserPhone" ADD CONSTRAINT "UserPhone_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserPhone_phone_idx" ON "UserPhone"("phone");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserPhone_userId_phone_key" ON "UserPhone"("userId", "phone");

-- At most one primary per account. Prisma has no way to declare a partial
-- index, so it lives here only.
CREATE UNIQUE INDEX IF NOT EXISTS "UserPhone_userId_primary_key" ON "UserPhone"("userId") WHERE "primary";
