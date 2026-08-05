-- Named provider keys, in the order their owner wants them tried.
--
-- One key per provider was a limit nobody asked for: a work account and a
-- personal one are the same provider, and so are two keys with different spend
-- caps. Which one a run reaches for is now an explicit order rather than the
-- accident of there being only one, so the list needs a position and each row
-- needs a name to be addressable by.
ALTER TABLE "UserModelKey" ADD COLUMN "name" TEXT;
ALTER TABLE "UserModelKey" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- Existing rows keep working: the provider slug is a name its owner recognises,
-- and the order they already had (one each, by provider) becomes the list.
UPDATE "UserModelKey" SET "name" = "provider" WHERE "name" IS NULL;

UPDATE "UserModelKey" AS target
SET "priority" = ordered."position"
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "provider") - 1 AS "position"
    FROM "UserModelKey"
) AS ordered
WHERE target."id" = ordered."id";

ALTER TABLE "UserModelKey" ALTER COLUMN "name" SET NOT NULL;

DROP INDEX "UserModelKey_userId_provider_key";
DROP INDEX "UserModelKey_userId_idx";

CREATE UNIQUE INDEX "UserModelKey_userId_provider_name_key" ON "UserModelKey"("userId", "provider", "name");
CREATE INDEX "UserModelKey_userId_priority_idx" ON "UserModelKey"("userId", "priority");
