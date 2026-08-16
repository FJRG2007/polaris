-- AlterTable
ALTER TABLE "ChatChannel" ADD COLUMN     "membersMayEdit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" UUID;


-- Every group that already exists is run by whoever started it. Without this
-- backfill an existing group has no owner at all, which reads on screen as a
-- group nobody may rename - including the person who made it.
UPDATE "ChatChannel" SET "ownerId" = "createdById" WHERE "kind" = 'group' AND "ownerId" IS NULL;
