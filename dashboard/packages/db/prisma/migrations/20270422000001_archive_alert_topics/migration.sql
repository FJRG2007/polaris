-- Alert topics were carried into Automations by the previous migration, which
-- always runs first; nothing reads these tables any more.
--
-- Archived, not dropped: renamed out of the way with their rows intact, so a
-- topic the carry could not take (its id already used by another automation)
-- or anything it carried wrong can still be recovered. A later release drops
-- the archive once nobody needs it. Rerunnable: each rename only happens while
-- the old name exists and the archive name does not.
ALTER TABLE IF EXISTS "AlertDelivery" DROP CONSTRAINT IF EXISTS "AlertDelivery_topicId_fkey";
ALTER TABLE IF EXISTS "AlertTopic" DROP CONSTRAINT IF EXISTS "AlertTopic_ownerId_fkey";
ALTER TABLE IF EXISTS "AlertTopic" DROP CONSTRAINT IF EXISTS "AlertTopic_orgId_fkey";

DO $$
BEGIN
    IF to_regclass('"AlertDelivery"') IS NOT NULL AND to_regclass('"AlertDelivery_archived"') IS NULL THEN
        ALTER TABLE "AlertDelivery" RENAME TO "AlertDelivery_archived";
    END IF;
    IF to_regclass('"AlertTopic"') IS NOT NULL AND to_regclass('"AlertTopic_archived"') IS NULL THEN
        ALTER TABLE "AlertTopic" RENAME TO "AlertTopic_archived";
    END IF;
END $$;
