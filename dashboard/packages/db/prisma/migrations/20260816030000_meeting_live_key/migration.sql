-- One live call per conversation, enforced by the database.
--
-- Looking for a running call and then creating one if there is none is two
-- statements, and two people pressing the button in the same conversation at the
-- same instant fit between them - each ending up alone in their own room. This
-- column holds the conversation while the call runs and is released when it
-- ends, so the second insert is refused and reads back the first.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "liveKey" UUID;

-- Backfill: the oldest running call in each conversation keeps it. Anything that
-- already raced stays reachable but stops being the one a new caller joins.
UPDATE "Meeting" AS m
SET "liveKey" = m."channelId"
WHERE m."endedAt" IS NULL
  AND m."channelId" IS NOT NULL
  AND m."id" = (
      SELECT o."id"
      FROM "Meeting" o
      WHERE o."channelId" = m."channelId" AND o."endedAt" IS NULL
      ORDER BY o."startedAt" ASC, o."id" ASC
      LIMIT 1
  );

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_liveKey_key" ON "Meeting"("liveKey");
